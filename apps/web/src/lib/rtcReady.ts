/**
 * Cloudflare refuses a renegotiation — another track sent, a track closed, a
 * new one pulled — on a connection that has not finished connecting: "Session
 * appears to be disconnected" (HTTP 410). The page then threw the connection
 * away and built a new one: a join that sent the camera and then the
 * microphone did this every time, and a camera switched back on took seconds.
 * So a connection already negotiated is waited for (briefly) before it is
 * renegotiated; the first negotiation, which is what connects it, never waits.
 * A connection that fails or does not connect in time goes on and meets the
 * recovery it always had.
 */
export function untilConnected(pc: RTCPeerConnection, ms = 8_000): Promise<void> {
  return new Promise((resolve) => {
    const settled = () =>
      !pc.remoteDescription ||
      pc.connectionState === 'connected' ||
      pc.connectionState === 'failed' ||
      pc.connectionState === 'closed';
    if (settled()) return resolve();
    const done = () => {
      pc.removeEventListener('connectionstatechange', on);
      clearTimeout(t);
      resolve();
    };
    const on = () => {
      if (settled()) done();
    };
    const t = setTimeout(done, ms);
    pc.addEventListener('connectionstatechange', on);
  });
}
