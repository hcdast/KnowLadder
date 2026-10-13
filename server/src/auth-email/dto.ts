import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsString, Matches, MaxLength, MinLength, Validate, ValidatorConstraint, type ValidatorConstraintInterface } from "class-validator";
import { validPassword } from "../database/contracts";
import { normalizeEmail } from "./tokens";
@ValidatorConstraint({ name: "emailAddress" })
class EmailAddress implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== "string") return false;
    try { normalizeEmail(value); return true; } catch { return false; }
  }
}
@ValidatorConstraint({ name: "emailPassword" })
class EmailPassword implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === "string" && validPassword(value); }
}
export class EmailRequestDto {
  @ApiProperty({ format: "email", maxLength: 254 })
  @Validate(EmailAddress)
  email!: string;
}
export class RegisterEmailDto extends EmailRequestDto {
  @ApiProperty({ enum: ["adult"] }) @IsIn(["adult"]) age_band!: "adult";
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) terms_version!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) privacy_notice_version!: string;
}
export class EmailTokenDto {
  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{43}$", writeOnly: true })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
export class ActivateEmailDto extends EmailTokenDto {
  @ApiProperty({ enum: ["adult"] }) @IsIn(["adult"]) age_band!: "adult";
  @ApiProperty({ enum: [true] }) @IsBoolean() accepted_terms!: boolean;
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) terms_version!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) privacy_notice_version!: string;
  @ApiProperty({ minLength: 1, maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) display_name!: string;
  @ApiProperty({ minLength: 6, maxLength: 128, format: "password", writeOnly: true })
  @Validate(EmailPassword) new_password!: string;
}
export class ResetEmailDto extends EmailTokenDto {
  @ApiProperty({ minLength: 6, maxLength: 128, format: "password", writeOnly: true })
  @Validate(EmailPassword) new_password!: string;
}
export class BindEmailDto extends EmailRequestDto {
  @ApiProperty({ pattern: "^[0-9a-f]{24}$", description: "操作表单展示的本人账号ID；与当前Cookie身份不一致时拒绝，不能自动重试" })
  @IsString() @Matches(/^[0-9a-f]{24}$/) expected_user_id!: string;
  @ApiProperty({ minLength: 6, maxLength: 128, format: "password", writeOnly: true })
  @Validate(EmailPassword) current_password!: string;
}
export class RemoveEmailDto {
  @ApiProperty({ pattern: "^[0-9a-f]{24}$", description: "操作表单展示的本人账号ID；与当前Cookie身份不一致时拒绝，不能自动重试" })
  @IsString() @Matches(/^[0-9a-f]{24}$/) expected_user_id!: string;
  @ApiProperty({ minLength: 6, maxLength: 128, format: "password", writeOnly: true })
  @Validate(EmailPassword) current_password!: string;
}
