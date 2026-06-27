import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

function getSocket() {
  if (!socket) {
    socket = io({ transports: ['websocket', 'polling'], autoConnect: true });
  }
  return socket;
}

export function useSocket(event, handler) {
  useEffect(() => {
    const s = getSocket();
    s.on(event, handler);
    return () => s.off(event, handler);
  }, [event, handler]);
}

export function useSocketStatus() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const s = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    setConnected(s.connected);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
    };
  }, []);

  return connected;
}

export { getSocket };
