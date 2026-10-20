const mockConstructEvent = jest.fn();

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ webhooks: { constructEvent: mockConstructEvent } })),
);
jest.mock('../../config/config', () => ({
  config: { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec' },
}));
jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../../lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: jest.fn(), update: jest.fn() },
    creditLog: { create: jest.fn() },
    stripeEvent: { createMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { BillingService } from '../BillingService';
import { prisma } from '../../lib/prisma';

describe('Stripe webhook idempotency (#1781)', () => {
  it('applies invoice.payment_succeeded once and skips a replay of the same event.id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_cycle' } },
    });
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) => fn(prisma));
    (prisma.subscription.findFirst as jest.Mock).mockResolvedValue({ userId: 'u1', plan: 'free' });
    (prisma.stripeEvent.createMany as jest.Mock)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const svc = new BillingService();
    await svc.handleWebhook(Buffer.from('x'), 'sig');
    await svc.handleWebhook(Buffer.from('x'), 'sig');

    expect(prisma.creditLog.create).toHaveBeenCalledTimes(1);
  });
});
