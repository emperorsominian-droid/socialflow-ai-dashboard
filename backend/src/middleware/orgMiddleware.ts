import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthRequest } from './authenticate';
import { prisma } from '../lib/prisma';

/**
 * Resolves the active organization from the `x-org-id` request header.
 * Verifies the authenticated user is a member of that org.
 * Attaches `req.activeOrgId` for downstream use.
 */
export async function orgMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawOrgId = req.headers['x-org-id'];
  if (!rawOrgId) {
    res.status(400).json({ message: 'Missing x-org-id header' });
    return;
  }

  const parsed = z.string().uuid().safeParse(rawOrgId);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid x-org-id header' });
    return;
  }
  const orgId = parsed.data;

  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: req.user!.id } },
  });

  if (!membership) {
    res.status(403).json({ message: 'Not a member of this organization' });
    return;
  }

  req.activeOrgId = orgId;
  next();
}
