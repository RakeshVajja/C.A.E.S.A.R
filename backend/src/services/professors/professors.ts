import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { CLEARED_RECOVERY_CODE } from '../auth/accounts';
import { generateTemporaryPassword, hashPassword } from '../auth/password';

/**
 * Professor management by the administrator (Project_plan.md §6.2, §15, Phase 9; decisions
 * #66, #70, #71). Professors are deactivated, never deleted. A professor's login account is a
 * PROFESSOR user created together with a temporary password that is returned once and never stored
 * in plain text; Phase 8 forces a change at first login. Email lives only on the user.
 */

const detailInclude = {
  user: { select: { id: true, email: true, mustChangePassword: true } },
  identities: {
    select: { id: true, source: true, externalId: true, isActive: true, verifiedAt: true, createdAt: true },
    orderBy: [{ source: 'asc' }, { externalId: 'asc' }],
  },
} satisfies Prisma.ProfessorInclude;

type ProfessorWithDetail = Prisma.ProfessorGetPayload<{ include: typeof detailInclude }>;

export interface ProfileInput {
  name?: string;
  department?: string | null;
  designation?: string | null;
}

export function professorDetail(professor: ProfessorWithDetail) {
  return {
    id: professor.id,
    name: professor.name,
    department: professor.department,
    designation: professor.designation,
    isActive: professor.isActive,
    createdAt: professor.createdAt,
    updatedAt: professor.updatedAt,
    account: professor.user
      ? { id: professor.user.id, email: professor.user.email, mustChangePassword: professor.user.mustChangePassword }
      : null,
    identities: professor.identities,
  };
}

const notFound = () => new HttpError(404, 'PROFESSOR_NOT_FOUND', 'Professor not found');
const emailInUse = () => new HttpError(409, 'EMAIL_IN_USE', 'This email address is already used by another account');

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** All professors, active and inactive, ordered by name (no pagination at department scale, #70). */
export async function listProfessors(client: PrismaClient = defaultClient) {
  const professors = await client.professor.findMany({
    include: { user: { select: { email: true, mustChangePassword: true } }, _count: { select: { identities: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return professors.map((p) => ({
    id: p.id,
    name: p.name,
    department: p.department,
    designation: p.designation,
    isActive: p.isActive,
    account: p.user ? { email: p.user.email, mustChangePassword: p.user.mustChangePassword } : null,
    identityCount: p._count.identities,
  }));
}

export async function getProfessor(id: string, client: PrismaClient = defaultClient) {
  const professor = await client.professor.findUnique({ where: { id }, include: detailInclude });
  if (!professor) throw notFound();
  return professorDetail(professor);
}

/**
 * Creates a professor and its PROFESSOR login account in one nested write (both or neither).
 * The role is fixed here; clients cannot choose it.
 */
export async function createProfessor(
  input: Required<Pick<ProfileInput, 'name'>> & ProfileInput & { email: string },
  client: PrismaClient = defaultClient,
) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const professor = await client.professor.create({
      data: {
        name: input.name,
        department: input.department ?? null,
        designation: input.designation ?? null,
        user: { create: { email: input.email, passwordHash, role: 'PROFESSOR', mustChangePassword: true } },
      },
      include: detailInclude,
    });
    return { professor: professorDetail(professor), temporaryPassword };
  } catch (error) {
    if (isUniqueViolation(error)) throw emailInUse();
    throw error;
  }
}

/** Creates the login account of an existing professor who has none (e.g. created before Phase 9). */
export async function createProfessorAccount(professorId: string, email: string, client: PrismaClient = defaultClient) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const professor = await client.$transaction(async (tx) => {
      const existing = await tx.professor.findUnique({ where: { id: professorId }, select: { userId: true } });
      if (!existing) throw notFound();
      if (existing.userId) throw new HttpError(409, 'ACCOUNT_EXISTS', 'This professor already has a login account');
      const user = await tx.user.create({ data: { email, passwordHash, role: 'PROFESSOR', mustChangePassword: true } });
      // Conditional link: a concurrent request that linked first makes this one roll back entirely.
      const { count } = await tx.professor.updateMany({ where: { id: professorId, userId: null }, data: { userId: user.id } });
      if (count !== 1) throw new HttpError(409, 'ACCOUNT_EXISTS', 'This professor already has a login account');
      return tx.professor.findUniqueOrThrow({ where: { id: professorId }, include: detailInclude });
    });
    return { professor: professorDetail(professor), temporaryPassword };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // users.email or professors.user_id: report the account conflict precisely.
      const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
      if (Array.isArray(target) && target.includes('user_id')) {
        throw new HttpError(409, 'ACCOUNT_EXISTS', 'This professor already has a login account');
      }
      throw emailInUse();
    }
    throw error;
  }
}

/**
 * Updates profile fields and, when given, the login email. An email change clears a pending
 * recovery code (sent to the old address) in the same transaction; send limits stay (#70).
 */
export async function updateProfessor(
  id: string,
  input: ProfileInput & { email?: string },
  client: PrismaClient = defaultClient,
) {
  try {
    const professor = await client.$transaction(async (tx) => {
      const existing = await tx.professor.findUnique({ where: { id }, include: { user: { select: { id: true, email: true } } } });
      if (!existing) throw notFound();

      if (input.email !== undefined && input.email !== existing.user?.email) {
        if (!existing.user) throw new HttpError(409, 'NO_ACCOUNT', 'This professor has no login account; create one first');
        await tx.user.update({ where: { id: existing.user.id }, data: { email: input.email, ...CLEARED_RECOVERY_CODE } });
      }
      const profile: ProfileInput = {};
      if (input.name !== undefined) profile.name = input.name;
      if (input.department !== undefined) profile.department = input.department;
      if (input.designation !== undefined) profile.designation = input.designation;
      return tx.professor.update({ where: { id }, data: profile, include: detailInclude });
    });
    return professorDetail(professor);
  } catch (error) {
    if (isUniqueViolation(error)) throw emailInUse();
    throw error;
  }
}

/**
 * Activates or deactivates a professor (idempotent). Nothing else changes: identities keep their
 * own flags and all relationships stay (decision #71). Phase 8 already refuses sign-in and ends
 * sessions of inactive professors, and discovery skips their identities.
 */
export async function setProfessorActive(id: string, isActive: boolean, client: PrismaClient = defaultClient) {
  const { count } = await client.professor.updateMany({ where: { id }, data: { isActive } });
  if (count !== 1) throw notFound();
  return getProfessor(id, client);
}

/** The signed-in professor's own profile (decision #67). */
export async function getOwnProfile(userId: string, client: PrismaClient = defaultClient) {
  const professor = await client.professor.findUnique({
    where: { userId },
    include: { user: { select: { email: true } } },
  });
  if (!professor) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'No professor profile is linked to this account');
  return {
    id: professor.id,
    name: professor.name,
    department: professor.department,
    designation: professor.designation,
    email: professor.user!.email,
  };
}

/** Professors may change only their own name; everything else is administrator-managed (#67). */
export async function updateOwnName(userId: string, name: string, client: PrismaClient = defaultClient) {
  const { count } = await client.professor.updateMany({ where: { userId }, data: { name } });
  if (count !== 1) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'No professor profile is linked to this account');
  return getOwnProfile(userId, client);
}
