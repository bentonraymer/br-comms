import { CreateRoom } from './pages/CreateRoom.tsx';
import { Home } from './pages/Home.tsx';
import { RoomEntry } from './pages/RoomEntry.tsx';
import { useLocation } from './router.ts';

export function App() {
  const { path, search } = useLocation();
  const room = path.match(/^\/r\/([a-z0-9]+)\/?$/);
  if (room) return <RoomEntry key={room[1]} roomId={room[1]} joinToken={new URLSearchParams(search).get('t')} />;
  if (path === '/new') return <CreateRoom />;
  return <Home />;
}
