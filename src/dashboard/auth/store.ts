import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  accessRequests,
  dashboardSessions,
  type AccessRequestRow,
  type DashboardSessionRow,
} from '../../db/schema.js';
import { ttl } from '../config.js';

/**
 * The dashboard's auth store (web-dashboard D-WD4). These writes (sessions +
 * access requests) are the ONLY mutations the dashboard makes — everything else
 * it reads. Session/request lifetimes come from `ttl`.
 */
export class AuthStore {
  constructor(private readonly db: Db) {}

  // --- Access requests (device pairing) ------------------------------------

  async createRequest(deviceHint: string): Promise<AccessRequestRow> {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttl.request);
    const [row] = await this.db
      .insert(accessRequests)
      .values({ secret, deviceHint, status: 'pending', expiresAt })
      .returning();
    if (!row) throw new Error('failed to create access request');
    return row;
  }

  async getRequest(id: string): Promise<AccessRequestRow | null> {
    const [row] = await this.db.select().from(accessRequests).where(eq(accessRequests.id, id));
    return row ?? null;
  }

  /** Approve a still-pending, unexpired request (returns false otherwise). */
  async approveRequest(id: string): Promise<boolean> {
    const res = await this.db
      .update(accessRequests)
      .set({ status: 'approved', approvedAt: new Date() })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending')))
      .returning({ id: accessRequests.id });
    return res.length > 0;
  }

  async setRequestStatus(id: string, status: string, sessionId?: string): Promise<void> {
    await this.db
      .update(accessRequests)
      .set({ status, ...(sessionId ? { sessionId } : {}) })
      .where(eq(accessRequests.id, id));
  }

  // --- Sessions ------------------------------------------------------------

  async createSession(deviceHint: string): Promise<DashboardSessionRow> {
    const expiresAt = new Date(Date.now() + ttl.session);
    const [row] = await this.db
      .insert(dashboardSessions)
      .values({ deviceHint, expiresAt, lastSeenAt: new Date() })
      .returning();
    if (!row) throw new Error('failed to create session');
    return row;
  }

  /** A session is valid only if it exists, isn't revoked, and hasn't expired. */
  async getValidSession(id: string): Promise<DashboardSessionRow | null> {
    const [row] = await this.db.select().from(dashboardSessions).where(eq(dashboardSessions.id, id));
    if (!row || row.revoked || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  async touchSession(id: string): Promise<void> {
    await this.db
      .update(dashboardSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(dashboardSessions.id, id));
  }

  async revokeSession(id: string): Promise<void> {
    await this.db
      .update(dashboardSessions)
      .set({ revoked: true })
      .where(eq(dashboardSessions.id, id));
  }

  /** Default-deny housekeeping: mark timed-out pending requests expired. */
  async expireStaleRequests(): Promise<void> {
    await this.db
      .update(accessRequests)
      .set({ status: 'expired' })
      .where(and(eq(accessRequests.status, 'pending'), lt(accessRequests.expiresAt, new Date())));
  }
}
