import { AttendanceScreen } from '../../../src/screens/attendance/AttendanceScreen';

/**
 * Route: /(app)/attendance
 * Delegates entirely to the AttendanceScreen component so all business logic,
 * hooks, and UI stay in src/ and remain testable outside the router.
 */
export default AttendanceScreen;
