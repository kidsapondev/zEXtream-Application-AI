import { IsIn } from 'class-validator';
import { UserRole } from '@prisma/client';

const ROLES = Object.values(UserRole);

export class UpdateUserRoleDto {
  @IsIn(ROLES)
  role!: UserRole;
}
