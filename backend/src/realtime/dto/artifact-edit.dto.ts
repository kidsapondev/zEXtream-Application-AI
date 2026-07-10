import { IsString, IsUUID } from 'class-validator';
import { MAX_ARTIFACT_CONTENT_BYTES } from '../../artifacts/artifacts.service';
import { MaxUtf8Bytes } from './max-utf8-bytes.validator';

export class ArtifactEditDto {
  @IsUUID()
  artifactId!: string;

  @IsString()
  @MaxUtf8Bytes(MAX_ARTIFACT_CONTENT_BYTES)
  content!: string;
}
