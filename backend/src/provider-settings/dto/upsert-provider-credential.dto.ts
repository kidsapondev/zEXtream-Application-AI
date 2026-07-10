import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpsertProviderCredentialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey!: string;
}
