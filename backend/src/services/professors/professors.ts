import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { CLEARED_RECOVERY_CODE } from '../auth/accounts';
import {
  deliverTemporaryPassword,
  InvitationDeps,
  InvitationStatus,
  issueTemporaryPassword,
  serializeInvitation,
} from './invitations';

/**
 * Professor management by the administrator (Project_plan.md §6.2, §15, Phase 9; decisions
 * #66, #70, #71, #102). Professors are deactivated, never deleted. A professor's login account is a
 * PROFESSOR user whose temporary password is emailed to the professor (never returned to the
 * administrator, logged or stored in plain text) and must be changed at first login. Email lives
 * only on the user.
 */

const accountSelect = { id: true, email: true, mustChangePassword: true, temporaryPasswordExpiresAt: true } as const;

const detailInclude = {
  user: { select: accountSelect },
  identities: {
    select: {
      id: true,
      source: true,
      externalId: true,
      isActive: true,
      verifiedAt: true,
      verificationMethod: true,
      verificationEvidenceUrl: true,
      createdAt: true,
    },
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
      ? {
          id: professor.user.id,
          email: professor.user.email,
          mustChangePassword: professor.user.mustChangePassword,
          activated: !professor.user.mustChangePassword,
          temporaryPasswordExpiresAt: professor.user.mustChangePassword ? professor.user.temporaryPasswordExpiresAt : null,
        }
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
    include: { user: { select: accountSelect }, _count: { select: { identities: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return professors.map((p) => ({
    id: p.id,
    name: p.name,
    department: p.department,
    designation: p.designation,
    isActive: p.isActive,
    account: p.user
      ? {
          email: p.user.email,
          mustChangePassword: p.user.mustChangePassword,
          activated: !p.user.mustChangePassword,
          temporaryPasswordExpiresAt: p.user.mustChangePassword ? p.user.temporaryPasswordExpiresAt : null,
        }
      : null,
    identityCount: p._count.identities,
  }));
}

export async function getProfessor(id: string, client: PrismaClient = defaultClient) {
  const professor = await client.professor.findUnique({ where: { id }, include: detailInclude });
  if (!professor) throw notFound();
  return professorDetail(professor);
}

/**
 * Creates a professor and its PROFESSOR login account in one nested write (both or neither), then
 * emails the temporary password (#102). The role is fixed here; clients cannot choose it. A failed
 * or unconfigured delivery keeps the account; the administrator resends later.
 */
export async function createProfessor(
  input: Required<Pick<ProfileInput, 'name'>> & ProfileInput & { email: string },
  deps: InvitationDeps,
): Promise<{ professor: ReturnType<typeof professorDetail>; invitation: { status: InvitationStatus } }> {
  const client = deps.client ?? defaultClient;
  const issued = await issueTemporaryPassword(deps.now());
  let professor: ProfessorWithDetail;
  try {
    professor = await client.professor.create({
      data: {
        name: input.name,
        department: input.department ?? null,
        designation: input.designation ?? null,
        user: {
          create: {
            email: input.email,
            passwordHash: issued.passwordHash,
            temporaryPasswordExpiresAt: issued.expiresAt,
            role: 'PROFESSOR',
            mustChangePassword: true,
          },
        },
      },
      include: detailInclude,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw emailInUse();
    throw error;
  }
  const user = professor.user!;
  const status = await serializeInvitation(professor.id, () => deliverTemporaryPassword(user, issued, deps));
  return { professor: professorDetail(await reload(client, professor.id)), invitation: { status } };
}

/**
 * Creates the login account of an existing professor who has none (e.g. created before Phase 9)
 * and emails its temporary password (#102).
 */
export async function createProfessorAccount(professorId: string, email: string, deps: InvitationDeps) {
  const client = deps.client ?? defaultClient;
  const issued = await issueTemporaryPassword(deps.now());
  let user: { id: string; email: string };
  try {
    user = await client.$transaction(async (tx) => {
      const existing = await tx.professor.findUnique({ where: { id: professorId }, select: { userId: true } });
      if (!existing) throw notFound();
      if (existing.userId) throw accountExists();
      const created = await tx.user.create({
        data: { email, passwordHash: issued.passwordHash, temporaryPasswordExpiresAt: issued.expiresAt, role: 'PROFESSOR', mustChangePassword: true },
      });
      // Conditional link: a concurrent request that linked first makes this one roll back entirely.
      const { count } = await tx.professor.updateMany({ where: { id: professorId, userId: null }, data: { userId: created.id } });
      if (count !== 1) throw accountExists();
      return { id: created.id, email: created.email };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // users.email or professors.user_id: report the account conflict precisely.
      const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
      if (Array.isArray(target) && target.includes('user_id')) throw accountExists();
      throw emailInUse();
    }
    throw error;
  }
  const status = await serializeInvitation(professorId, () => deliverTemporaryPassword(user, issued, deps));
  return { professor: professorDetail(await reload(client, professorId)), invitation: { status } };
}

/**
 * Emails new sign-in details to a professor whose account is not yet activated (#102): a new
 * temporary password and expiry replace the previous ones in one conditional UPDATE, so the old
 * password stops working immediately (and sessions opened with it end, through the password
 * fingerprint). Without SMTP nothing changes and NOT_CONFIGURED is reported.
 */
export async function resendInvitation(professorId: string, deps: InvitationDeps) {
  const client = deps.client ?? defaultClient;
  return serializeInvitation(professorId, async () => {
    const professor = await client.professor.findUnique({ where: { id: professorId }, include: detailInclude });
    if (!professor) throw notFound();
    if (!professor.user) throw new HttpError(409, 'NO_ACCOUNT', 'This professor has no login account; create one first');
    if (!professor.isActive) throw new HttpError(409, 'PROFESSOR_INACTIVE', 'Reactivate the professor before sending sign-in details');
    if (!professor.user.mustChangePassword) throw alreadyActive();
    if (!deps.mailer) return { professor: professorDetail(professor), invitation: { status: 'NOT_CONFIGURED' as InvitationStatus } };

    const issued = await issueTemporaryPassword(deps.now());
    const { count } = await client.user.updateMany({
      where: { id: professor.user.id, role: 'PROFESSOR', mustChangePassword: true },
      data: { passwordHash: issued.passwordHash, temporaryPasswordExpiresAt: issued.expiresAt, ...CLEARED_RECOVERY_CODE },
    });
    if (count !== 1) throw alreadyActive();
    const status = await deliverTemporaryPassword(professor.user, issued, deps);
    return { professor: professorDetail(await reload(client, professorId)), invitation: { status } };
  });
}

const accountExists = () => new HttpError(409, 'ACCOUNT_EXISTS', 'This professor already has a login account');
const alreadyActive = () =>
  new HttpError(409, 'ACCOUNT_ALREADY_ACTIVE', 'This professor has already chosen a password; they can use “Forgot password” on the sign-in page');

function reload(client: PrismaClient, id: string) {
  return client.professor.findUniqueOrThrow({ where: { id }, include: detailInclude });
}

/**
 * Updates profile fields and, when given, the login email. An email change clears a pending
 * recovery code (sent to the old address) in the same transaction; send limits stay (#70). When the
 * account is not yet activated, the same conditional UPDATE also replaces the temporary password,
 * so the one sent to the old address stops working, and the new one is emailed to the new address
 * (#102). Returns the delivery status in that case.
 */
export async function updateProfessor(id: string, input: ProfileInput & { email?: string }, deps: InvitationDeps) {
  const client = deps.client ?? defaultClient;
  return serializeInvitation(id, async () => {
    const issued = input.email !== undefined ? await issueTemporaryPassword(deps.now()) : null;
    let reissuedFor: { id: string; email: string } | null = null;
    let professor: ProfessorWithDetail;
    try {
      professor = await client.$transaction(async (tx) => {
        const existing = await tx.professor.findUnique({ where: { id }, include: { user: { select: { id: true, email: true } } } });
        if (!existing) throw notFound();

        if (input.email !== undefined && input.email !== existing.user?.email) {
          if (!existing.user) throw new HttpError(409, 'NO_ACCOUNT', 'This professor has no login account; create one first');
          // Not yet activated: new email and new temporary password together; otherwise only the email.
          const { count } = await tx.user.updateMany({
            where: { id: existing.user.id, role: 'PROFESSOR', mustChangePassword: true },
            data: { email: input.email, passwordHash: issued!.passwordHash, temporaryPasswordExpiresAt: issued!.expiresAt, ...CLEARED_RECOVERY_CODE },
          });
          if (count === 1) reissuedFor = { id: existing.user.id, email: input.email };
          else await tx.user.update({ where: { id: existing.user.id }, data: { email: input.email, ...CLEARED_RECOVERY_CODE } });
        }
        const profile: ProfileInput = {};
        if (input.name !== undefined) profile.name = input.name;
        if (input.department !== undefined) profile.department = input.department;
        if (input.designation !== undefined) profile.designation = input.designation;
        return tx.professor.update({ where: { id }, data: profile, include: detailInclude });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailInUse();
      throw error;
    }
    if (!reissuedFor || !issued) return { professor: professorDetail(professor) };
    const status = await deliverTemporaryPassword(reissuedFor, issued, deps);
    return { professor: professorDetail(await reload(client, id)), invitation: { status } };
  });
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
