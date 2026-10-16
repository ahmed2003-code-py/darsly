import { untilConnected } from './rtcReady';

/** Just enough of an RTCPeerConnection: its state, its answer, its event. */
function fakePc(state: RTCPeerConnectionState, negotiated = true) {
  const t = new EventTarget() as EventTarget & {
    connectionState: RTCPeerConnectionState;
    remoteDescription: object | null;
    set(s: RTCPeerConnectionState): void;
  };
  t.connectionState = state;
  t.remoteDescription = negotiated ? {} : null;
  t.set = (s) => {
    t.connectionState = s;
    t.dispatchEvent(new Event('connectionstatechange'));
  };
  return t;
}
const pc = (t: ReturnType<typeof fakePc>) => t as unknown as RTCPeerConnection;
const resolvedYet = async (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe('renegotiating only a connected connection', () => {
  it('the first negotiation never waits (it is what connects the connection)', async () => {
    expect(await resolvedYet(untilConnected(pc(fakePc('new', false))))).toBe(true);
  });

  it('a connected connection goes on at once', async () => {
    expect(await resolvedYet(untilConnected(pc(fakePc('connected'))))).toBe(true);
  });

  it('a connection still connecting is waited for, then goes on', async () => {
    const t = fakePc('connecting');
    const p = untilConnected(pc(t));
    expect(await resolvedYet(p)).toBe(false);
    t.set('connected');
    expect(await resolvedYet(p)).toBe(true);
  });

  it('a failed connection goes on (to the recovery it always had)', async () => {
    const t = fakePc('connecting');
    const p = untilConnected(pc(t));
    t.set('failed');
    expect(await resolvedYet(p)).toBe(true);
  });

  it('never waits forever', async () => {
    jest.useFakeTimers();
    try {
      const p = untilConnected(pc(fakePc('connecting')), 1_000);
      jest.advanceTimersByTime(1_000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
