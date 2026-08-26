import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Query params for `GET /workspace/file`.
 *
 * No path validation beyond a length bound on purpose. Deciding what is inside the workspace
 * needs the real filesystem — symlinks especially — and the host-bridge already does that
 * check against the actual root. A second, weaker check here would only be a second place to
 * disagree, and the weaker one would be the one someone trusts.
 */
export class ReadFileQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  path!: string;
}
