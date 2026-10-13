import type { PublicUser } from '../services/auth/accounts';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth: the signed-in user as currently stored in the database. */
      auth?: { user: PublicUser };
    }
  }
}

export {};
