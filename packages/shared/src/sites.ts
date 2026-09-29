import { z } from 'zod';

/** Admin-managed sites, the team members who operate them, and the tasks registered for scan failures. */

export const siteCreateInput = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(500).optional(),
  ownerUserId: z.string().uuid().optional(),
});

export const siteUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().url().max(500).nullable().optional(),
    /** null clears the owner */
    ownerUserId: z.string().uuid().nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

/** Telegram numeric chat/user id (may be negative for groups) or a public @channel name. */
export const telegramChatId = z
  .string()
  .trim()
  .regex(/^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'a Telegram chat id (e.g. 123456789 or -1001234567890)');

export const teamMemberCreateInput = z.object({
  email: z.string().email().max(200),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200),
  telegramChatId: telegramChatId.optional(),
});

export const teamMemberUpdateInput = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    telegramChatId: telegramChatId.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

export interface SiteOwnerDto {
  id: string;
  displayName: string;
  email: string;
  telegramChatId: string | null;
}

export interface SiteDto {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  url: string | null;
  status: 'active' | 'paused';
  owner: SiteOwnerDto | null;
  /** most recent scan run for the site, if any */
  lastScan: { scanId: string; tool: string; status: string; at: string } | null;
  openFindings: number;
  /** tasks registered for this site (scan failures) */
  tasks: number;
  createdAt: string;
}

export interface TeamMemberDto {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  telegramChatId: string | null;
  /** org-level roles held (e.g. manager, security_admin): admins are alert recipients too */
  roles: string[];
  sites: { id: string; name: string }[];
  createdAt: string;
}

export type TaskStatus = 'pending' | 'sent' | 'failed';

export interface TaskDto {
  id: string;
  siteId: string | null;
  siteName: string | null;
  assignee: { id: string; displayName: string; email: string } | null;
  kind: string;
  title: string;
  description: string;
  status: TaskStatus;
  externalId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
