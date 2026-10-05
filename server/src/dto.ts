import { Transform } from "class-transformer";
import {
  IsString,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { normalizeLogin, validPassword } from "./database/contracts";
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
  @ApiProperty({ pattern: "^[a-z0-9_-]{3,64}$", description: "规范化登录名" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? normalizeLogin(value) : value,
  )
  @IsString()
  @Matches(/^[a-z0-9_-]{3,64}$/)
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
