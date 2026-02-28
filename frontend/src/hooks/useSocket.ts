import { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const enableRealtime = import.meta.env.DEV || import.meta.env.VITE_ENABLE_SOCKET === 'true';
    if (!enableRealtime) {
      setSocket(null);
      return;
    }

    const socketBaseUrl = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '');
    const newSocket = io(socketBaseUrl, { withCredentials: true });
    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  return socket;
};
