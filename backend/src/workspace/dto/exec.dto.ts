import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for `POST /workspace/exec`.
 *
 * `command` is a bare name; the host-bridge refuses anything containing a path separator and
 * anything absent from its allowlist. Not re-checked here for the same reason paths are not:
 * the allowlist lives on the host, next to the process that will actually be spawned.
 */
export class ExecDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  command!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  args?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  cwd?: string;
}
