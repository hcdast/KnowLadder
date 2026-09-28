import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { HttpException } from "@nestjs/common";
let active = 0;
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 4)
    throw new HttpException(
      { code: "AUTH_BUSY", message: "认证繁忙，请稍后重试" },
      503,
    );
  active++;
  try {
    return await work();
  } finally {
    active--;
  }
}
export const temporaryPassword = () => randomBytes(24).toString("base64url");
export const hashPassword = (password: string): Promise<string> =>
  bounded(() =>
    argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  );
export const verifyPassword = (
  hash: string,
  password: string,
): Promise<boolean> => bounded(() => argon2.verify(hash, password));
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(temporaryPassword()));
}
