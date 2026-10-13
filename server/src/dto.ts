import { Transform } from "class-transformer";
import {
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { normalizeLogin, validPassword } from "./database/contracts";
import { normalizeEmail } from "./auth-email/tokens";
@ValidatorConstraint({ name: "loginIdentifier" })
class LoginIdentifier implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== "string") return false;
    if (!value.includes("@")) return /^[a-z0-9_-]{3,64}$/.test(value);
    try { normalizeEmail(value); return true; } catch { return false; }
  }
}
@ValidatorConstraint({ name: "passwordPolicy" })
class PasswordPolicy implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === "string" && validPassword(value);
  }
  defaultMessage() {
    return "密码须为6至128字符且不超过512字节";
  }
}
export class LoginDto {
  @ApiProperty({ maxLength: 254, description: "用户名或已验证邮箱；邮箱密码登录不依赖发信开关" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? normalizeLogin(value) : value,
  )
  @IsString()
  @Validate(LoginIdentifier)
  login_name!: string;
  @ApiProperty({
    minLength: 6,
    maxLength: 128,
    format: "password",
    writeOnly: true,
  })
  @Validate(PasswordPolicy)
  password!: string;
}
export class ChangePasswordDto {
  @ApiProperty({
    minLength: 6,
    maxLength: 128,
    format: "password",
    writeOnly: true,
  })
  @Validate(PasswordPolicy)
  current_password!: string;
  @ApiProperty({
    minLength: 6,
    maxLength: 128,
    format: "password",
    writeOnly: true,
  })
  @Validate(PasswordPolicy)
  new_password!: string;
}
export class EmptyDto {}
