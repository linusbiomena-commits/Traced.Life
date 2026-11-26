import { hash, verify } from '@node-rs/argon2';

// Argon2id (the library default) with OWASP's recommended minimum: 19 MiB memory, 2 iterations.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spend the same time as a real check when the account doesn't exist (reduces user enumeration by timing). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** Returns a reason code if the password is unacceptable, otherwise null. */
export function passwordProblem(password: string, email?: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return 'TOO_SHORT';
  if (length > PASSWORD_MAX) return 'TOO_LONG';
  if (/^(.)\1+$/.test(password)) return 'TOO_SIMPLE';
  if (email) {
    const lower = password.toLowerCase();
    const local = email.split('@')[0] ?? '';
    if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return 'CONTAINS_EMAIL';
  }
  return null;
}
