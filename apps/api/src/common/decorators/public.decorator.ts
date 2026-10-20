import { SetMetadata } from '@nestjs/common';

/** Marks a route as anonymous (only auth entrypoints, health, webhooks, metrics). */
export const IS_PUBLIC_KEY = 'saman:isPublic';

/** `@Public()` exempts a controller/handler from the default-deny auth guard. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
