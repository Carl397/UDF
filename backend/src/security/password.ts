import argon2 from 'argon2';

/**
 * Password hashing with Argon2id (memory-hard, side-channel resistant).
 * Never store or log plaintext passwords.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024, // ~19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** True when a stored hash should be re-hashed due to updated parameters. */
export function needsRehash(hash: string): boolean {
  try {
    // Note: argon2.needsRehash reads the algorithm from the stored hash itself,
    // so only cost parameters are compared here.
    return argon2.needsRehash(hash, {
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    });
  } catch {
    return true;
  }
}
