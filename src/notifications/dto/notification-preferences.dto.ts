import { ArrayMaxSize, ArrayUnique, IsArray, IsIn } from 'class-validator';
import { NOTIFICATION_TYPES } from '../notification-types';

/**
 * PUT /api/v1/notification-preferences: the complete set of types the caller
 * does not want e-mailed or pushed. Which types the caller's role may name,
 * and which are required, is the service's to say (400 with the type named).
 */
export class NotificationPreferencesDto {
  @IsArray({ message: 'optOut: en lista med typer.' })
  @ArrayMaxSize(NOTIFICATION_TYPES.length, { message: 'optOut: högst en gång per typ.' })
  @ArrayUnique({ message: 'optOut: varje typ en gång.' })
  @IsIn(NOTIFICATION_TYPES, { each: true, message: 'optOut: okänd typ.' })
  optOut!: string[];
}
