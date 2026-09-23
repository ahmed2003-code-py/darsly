import { ChatGateway } from './chat.gateway';

/**
 * A socket that outlives its token.
 *
 * The handshake verifies the JWT once, and a socket then lives as long as the
 * tab does. Without a per-event check the connection kept whatever authority it
 * was opened with, long after the 15-minute access token behind it had expired.
 *
 * Demonstrated against a running gateway: a socket opened with a 2-second token
 * was still writing chat messages four seconds later. Not an authentication
 * bypass — a valid token is still needed to connect — but it defeats the point
 * of a short-lived one, and leaves a signed-out or revoked user acting on old
 * authority until they happen to close the page.
 *
 * Every handler that does anything reaches the user through one method, which
 * is why the check lives there and why these tests aim at it.
 */
describe('a socket acting on an expired token', () => {
  const build = () => {
    const chat: any = {
      canAccessThread: jest.fn().mockResolvedValue(true),
      markThreadRead: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue({ message: { id: 'm1' }, threadId: 't1' }),
    };
    const live: any = { assertInSession: jest.fn().mockResolvedValue(undefined) };
    const gateway = new ChatGateway({} as any, chat, { setServer: jest.fn() } as any, live);
    return { gateway, chat, live };
  };

  /** A socket carrying a payload that expired `agoSec` seconds ago. */
  const socketWith = (exp: number) => ({
    data: { user: { sub: 'u1', role: 'STUDENT', exp } },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  });

  const alive = () => Math.floor(Date.now() / 1000) + 600;
  const dead = () => Math.floor(Date.now() / 1000) - 1;

  it('is disconnected rather than served', async () => {
    const { gateway } = build();
    const client: any = socketWith(dead());
    await gateway.joinThread(client, 't1');
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.emit).toHaveBeenCalledWith('error', 'token expired');
  });

  it('cannot join a thread room', async () => {
    const { gateway, chat } = build();
    const client: any = socketWith(dead());
    await gateway.joinThread(client, 't1');
    expect(client.join).not.toHaveBeenCalled();
    expect(chat.canAccessThread).not.toHaveBeenCalled();
  });

  it('cannot send a message', async () => {
    const { gateway, chat } = build();
    const client: any = socketWith(dead());
    await gateway.sendMessage(client, { threadId: 't1', body: 'after expiry' } as any);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('cannot broadcast a typing echo', async () => {
    const { gateway } = build();
    const client: any = socketWith(dead());
    await gateway.typing(client, 't1');
    expect(client.to).not.toHaveBeenCalled();
  });

  it('cannot join a live classroom', async () => {
    const { gateway, live } = build();
    const client: any = socketWith(dead());
    await gateway.joinLive(client, 's1');
    expect(live.assertInSession).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('cannot mark a thread read', async () => {
    const { gateway, chat } = build();
    const client: any = socketWith(dead());
    await gateway.markRead(client, 't1');
    expect(chat.markThreadRead).not.toHaveBeenCalled();
  });
});

describe('a socket whose token is still alive', () => {
  // The guard must not break the thing it protects.
  const build = () => {
    const chat: any = {
      canAccessThread: jest.fn().mockResolvedValue(true),
      markThreadRead: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue({ message: { id: 'm1' }, threadId: 't1' }),
    };
    const live: any = { assertInSession: jest.fn().mockResolvedValue(undefined) };
    return {
      gateway: new ChatGateway({} as any, chat, { setServer: jest.fn() } as any, live),
      chat,
      live,
    };
  };
  const client = () => ({
    data: { user: { sub: 'u1', role: 'STUDENT', exp: Math.floor(Date.now() / 1000) + 600 } },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  });

  it('joins, sends and reads normally', async () => {
    const { gateway, chat } = build();
    const c: any = client();
    await gateway.joinThread(c, 't1');
    await gateway.sendMessage(c, { threadId: 't1', body: 'hello' } as any);
    await gateway.markRead(c, 't1');
    expect(c.disconnect).not.toHaveBeenCalled();
    expect(c.join).toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalled();
    expect(chat.markThreadRead).toHaveBeenCalled();
  });

  /**
   * A payload with no `exp` is treated as live, not as expired. Refusing it
   * would break any token shape that omits the claim, and the handshake has
   * already verified whatever was presented.
   */
  it('is not refused merely for carrying no expiry claim', async () => {
    const { gateway, chat } = build();
    const c: any = { ...client(), data: { user: { sub: 'u1', role: 'STUDENT' } } };
    await gateway.sendMessage(c, { threadId: 't1', body: 'hello' } as any);
    expect(c.disconnect).not.toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalled();
  });
});
