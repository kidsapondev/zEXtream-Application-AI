import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Validates that a string's UTF-8 byte length does not exceed `maxBytes`.
 * `@MaxLength()` counts UTF-16 code units, which is not equivalent for
 * multi-byte characters, so size limits meant to bound payload/storage size
 * need this instead.
 */
export function MaxUtf8Bytes(
  maxBytes: number,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxUtf8Bytes',
      target: object.constructor,
      propertyName,
      constraints: [maxBytes],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const [max] = args.constraints as [number];
          return Buffer.byteLength(value, 'utf8') <= max;
        },
        defaultMessage(args: ValidationArguments): string {
          const [max] = args.constraints as [number];
          return `${args.property} must not exceed ${max} bytes`;
        },
      },
    });
  };
}
