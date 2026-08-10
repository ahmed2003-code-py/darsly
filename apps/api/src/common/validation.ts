import { applyDecorators } from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/**
 * Shared input limits.
 *
 * Every string that reaches the database needs an upper bound. Without one a
 * single request can push megabytes into a text column, and the cost lands on
 * every later read of that row — the caps below are the project's default
 * answer to "how long is too long" so each DTO doesn't invent its own.
 */
export const LIMITS = {
  /** cuid() is 25 chars; 40 leaves room for any id scheme without inviting abuse. */
  ID: 40,
  /** Short human labels: names, titles, codes. */
  NAME: 120,
  /** A headline or one-line summary. */
  TITLE: 200,
  /** A paragraph: reasons, notes, feedback, short descriptions. */
  NOTE: 1_000,
  /** Long-form prose: course descriptions, assignment prompts, bios. */
  PROSE: 5_000,
  /** An external link. */
  URL: 500,
  /** Base64 image data URL — the ceiling for an avatar or thumbnail. */
  IMAGE_DATA_URL: 900_000,
  /** Payment proof photos are bigger: a receipt must stay legible. */
  PROOF_DATA_URL: 2_000_000,
  /** Bulk id lists (reorder, bundle contents, grade selections). */
  ARRAY: 200,
} as const;

/**
 * Transport ceiling for a JSON request body. Sits just above
 * `LIMITS.PROOF_DATA_URL` (2 MB of base64 + surrounding JSON) so the largest
 * legitimate payload fits and everything past it is refused at the edge.
 */
export const JSON_BODY_LIMIT = '3mb';

/** An entity id supplied by a client: a string, but never an essay. */
export function IsId(): PropertyDecorator {
  return applyDecorators(IsString(), MaxLength(LIMITS.ID));
}

/** Optional variant of {@link IsId}. */
export function IsOptionalId(): PropertyDecorator {
  return applyDecorators(IsOptional(), IsString(), MaxLength(LIMITS.ID));
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/;

/**
 * A `data:image/...;base64,...` URL, size-capped.
 *
 * Checking the prefix matters: these values are stored and later echoed into an
 * `<img src>`. Accepting any string there lets a `javascript:` or
 * `data:text/html` payload reach the browser that renders it.
 */
export function IsImageDataUrl(maxLength: number = LIMITS.IMAGE_DATA_URL): PropertyDecorator {
  return applyDecorators(
    IsString(),
    Matches(IMAGE_DATA_URL, { message: 'must be a base64-encoded image data URL' }),
    MaxLength(maxLength, { message: `image is too large (max ${Math.round(maxLength / 1024)} KB)` }),
  );
}

/**
 * An image reference that may be either a data URL or an https link — used
 * where a teacher can paste a hosted image instead of uploading one.
 */
export function IsImageRef(maxLength: number = LIMITS.IMAGE_DATA_URL): PropertyDecorator {
  return applyDecorators(
    IsString(),
    Matches(
      new RegExp(`^(https://[^\\s]+|${IMAGE_DATA_URL.source.slice(1, -1)})$`),
      { message: 'must be an https URL or a base64 image data URL' },
    ),
    MaxLength(maxLength),
  );
}

/** A 1-based page number. */
export function IsPage(): PropertyDecorator {
  return applyDecorators(IsOptional(), IsInt(), Min(1), Max(10_000));
}

/**
 * A page size, hard-capped. An uncapped `pageSize` is a denial-of-service knob:
 * one request asking for 100000 rows can outlast every other request in flight.
 */
export function IsPageSize(max = 50): PropertyDecorator {
  return applyDecorators(IsOptional(), IsInt(), Min(1), Max(max));
}

/**
 * A plain `{ key: value }` map with bounded key count, key length and value
 * length — for the answer/score bags that quizzes post back.
 *
 * `@IsObject()` alone accepts a map with a hundred thousand keys, and every one
 * of them gets iterated by the grading code.
 */
export function IsBoundedRecord(
  opts: { maxKeys?: number; maxKeyLength?: number; maxValueLength?: number } = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const maxKeys = opts.maxKeys ?? 200;
  const maxKeyLength = opts.maxKeyLength ?? LIMITS.ID;
  const maxValueLength = opts.maxValueLength ?? LIMITS.NOTE;

  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: 'isBoundedRecord',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length > maxKeys) return false;
          return entries.every(
            ([key, val]) =>
              key.length <= maxKeyLength &&
              (typeof val === 'number' ||
                (typeof val === 'string' && val.length <= maxValueLength)),
          );
        },
        defaultMessage() {
          return `${String(propertyName)} must be an object with at most ${maxKeys} entries, keys under ${maxKeyLength} chars and string values under ${maxValueLength} chars`;
        },
      },
    });
  };
}
