import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '../supabase';
import { assertSecureBaseUrl } from '../network/secureUrl';
import type { CalendarLessonUpdatedPayload } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// WebSocketClient wraps socket.io-client with:
//   - JWT auth handshake (token sent via `auth` option, never in the URL)
//   - Automatic reconnection with capped exponential backoff
//   - Typed event listener for `calendar_lesson_updated`
//
// Call connect() once when the teacher logs in, disconnect() on logout.
// ─────────────────────────────────────────────────────────────────────────────

const WS_BASE_URL = process.env['EXPO_PUBLIC_WS_BASE_URL'];

export type LessonUpdatedCallback = (payload: CalendarLessonUpdatedPayload) => void;
export type ConnectionChangeCallback = (connected: boolean) => void;

export class WebSocketClient {
  private socket: Socket | null = null;
  private readonly onLessonUpdated: LessonUpdatedCallback;
  private readonly onConnectionChange: ConnectionChangeCallback;

  constructor(
    onLessonUpdated: LessonUpdatedCallback,
    onConnectionChange: ConnectionChangeCallback,
  ) {
    this.onLessonUpdated = onLessonUpdated;
    this.onConnectionChange = onConnectionChange;
  }

  async connect(): Promise<void> {
    if (this.socket?.connected) return;

    if (!WS_BASE_URL) {
      console.error('[WebSocket] EXPO_PUBLIC_WS_BASE_URL is not set. Real-time updates disabled.');
      return;
    }
    assertSecureBaseUrl(WS_BASE_URL, 'EXPO_PUBLIC_WS_BASE_URL');

    const token = await getAccessToken();
    if (!token) {
      console.warn('[WebSocket] No auth token — skipping connection.');
      return;
    }

    this.socket = io(WS_BASE_URL, {
      transports: ['websocket'],
      // Token delivered via handshake auth, not as a query param in the URL.
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
      randomizationFactor: 0.5,
    });

    this.socket.on('connect', () => {
      console.info('[WebSocket] Connected to schedule gateway.');
      this.onConnectionChange(true);
    });

    this.socket.on('disconnect', (reason: string) => {
      console.warn(`[WebSocket] Disconnected: ${reason}`);
      this.onConnectionChange(false);
    });

    this.socket.on('connect_error', (err: Error) => {
      // Log the error type only — never log the full error object as it may
      // contain sensitive handshake data.
      console.error(`[WebSocket] Connection error: ${err.name}`);
      this.onConnectionChange(false);
    });

    this.socket.on('calendar_lesson_updated', (payload: CalendarLessonUpdatedPayload) => {
      this.onLessonUpdated(payload);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
