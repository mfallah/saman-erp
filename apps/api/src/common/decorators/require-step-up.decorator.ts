import { SetMetadata } from '@nestjs/common';

export const STEP_UP_METADATA_KEY = 'saman:require_step_up';

/**
 * Marks a route as requiring a fresh step-up token (`POST /auth/step-up`) for
 * the given action. The `StepUpGuard` compares the token's `act` claim with the
 * required action and binds it to the current session.
 */
export function RequireStepUp(action: string): MethodDecorator & ClassDecorator {
  return SetMetadata(STEP_UP_METADATA_KEY, action);
}
