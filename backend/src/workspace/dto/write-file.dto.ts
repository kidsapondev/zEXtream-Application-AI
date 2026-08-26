import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /workspace/file`. */
export class WriteFileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  path!: string;

  /**
   * The complete new file content. Not length-capped here: the host-bridge enforces its own
   * `BRIDGE_MAX_FILE_BYTES` and rejects anything larger with a message naming that setting,
   * which is more useful than a generic validation failure that names nothing.
   */
  @IsString()
  content!: string;
}
