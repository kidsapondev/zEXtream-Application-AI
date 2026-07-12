import { ArrayUnique, IsArray, IsIn } from 'class-validator';
import { AdminPermission } from '@prisma/client';

const PERMISSIONS = Object.values(AdminPermission);

export class UpdateUserPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSIONS, { each: true })
  permissions!: AdminPermission[];
}
