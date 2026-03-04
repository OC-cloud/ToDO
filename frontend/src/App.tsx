import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Calendar, CheckCircle2, CheckSquare, Circle, Clock, LayoutDashboard, LogOut, MessageCircle,
  MessageSquare, Plus, Send, Settings, Trash2, User as UserIcon
} from 'lucide-react';
import { format } from 'date-fns';
import api from './services/api';
import { useSocket } from './hooks/useSocket';
import { cn } from './lib/utils';

type AppView = 'dashboard' | 'profile' | 'settings';
type ThemeName = 'classic' | 'ocean' | 'sunset' | 'forest';
type TaskVisualState = 'normal' | 'nearDeadline' | 'overdue' | 'completed';

interface User { id: string; _id?: string; username: string; email: string; onlineStatus?: boolean; theme?: ThemeName; }
interface Comment { _id: string; taskId: string; userId: string; username: string; commentText: string; createdAt: string; }
interface Task {
  _id: string; title: string; description: string; dueDate: string; completed: boolean;
  createdBy: string; createdByUsername: string; createdAt: string;
}
interface Message { _id: string; senderId: string; senderName: string; message: string; timestamp: string; }

const themes: Record<ThemeName, { label: string; appBg: string; headerBg: string; primary: string; primaryHover: string; logo: string; }> = {
  classic: { label: 'Classic', appBg: 'bg-[#F5F5F0]', headerBg: 'bg-white', primary: 'bg-black', primaryHover: 'hover:bg-gray-800', logo: 'bg-black' },
  ocean: { label: 'Ocean', appBg: 'bg-sky-50', headerBg: 'bg-cyan-50', primary: 'bg-cyan-700', primaryHover: 'hover:bg-cyan-800', logo: 'bg-cyan-700' },
  sunset: { label: 'Sunset', appBg: 'bg-orange-50', headerBg: 'bg-amber-50', primary: 'bg-orange-600', primaryHover: 'hover:bg-orange-700', logo: 'bg-orange-600' },
  forest: { label: 'Forest', appBg: 'bg-emerald-50', headerBg: 'bg-emerald-100', primary: 'bg-emerald-700', primaryHover: 'hover:bg-emerald-800', logo: 'bg-emerald-700' },
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const isThemeName = (value: unknown): value is ThemeName =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(themes, value);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [theme, setTheme] = useState<ThemeName>('classic');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [newTask, setNewTask] = useState({ title: '', description: '', dueDate: '' });
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [taskComments, setTaskComments] = useState<Record<string, Comment[]>>({});
  const [newComment, setNewComment] = useState<Record<string, string>>({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [settingsError, setSettingsError] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  const socket = useSocket();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const t = themes[theme] || themes.classic;
  const completed = useMemo(() => tasks.filter((x) => x.completed).length, [tasks]);
  const myTasks = useMemo(() => {
    if (!user) return [] as Task[];
    return tasks.filter((task) => task.createdBy === user.id || task.createdBy === user._id);
  }, [tasks, user]);
  const otherUserTasks = useMemo(() => {
    if (!user) return tasks;
    return tasks.filter((task) => task.createdBy !== user.id && task.createdBy !== user._id);
  }, [tasks, user]);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      const parsedUser = JSON.parse(storedUser) as User;
      setUser(parsedUser);
      if (isThemeName(parsedUser.theme)) {
        setTheme(parsedUser.theme);
      }
    }
  }, []);
  useEffect(() => {
    if (!user) {
      setTheme('classic');
      return;
    }
    if (isThemeName(user.theme)) {
      setTheme(user.theme);
    } else {
      setTheme('classic');
    }
  }, [user]);
  useEffect(() => {
    if (!user) return;
    fetchTasks();
    fetchUsers();
    fetchMessages();
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const taskRefreshTimer = setInterval(() => {
      fetchTasks().catch(() => undefined);
    }, 60 * 1000);
    return () => clearInterval(taskRefreshTimer);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const messageRefreshTimer = setInterval(() => {
      fetchMessages().catch(() => undefined);
    }, 10 * 1000);
    return () => clearInterval(messageRefreshTimer);
  }, [user]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!socket || !user) return;
    socket.emit('authenticate', user.id);
    socket.on('receive_message', (m: Message) => setMessages((prev) => [...prev, m]));
    socket.on('user_status_change', ({ userId, onlineStatus }: { userId: string; onlineStatus: boolean }) => {
      setAllUsers((prev) => prev.map((u) => (u.id === userId || u._id === userId ? { ...u, onlineStatus } : u)));
    });
    return () => {
      socket.off('receive_message');
      socket.off('user_status_change');
    };
  }, [socket, user]);

  const fetchTasks = async () => {
    const res = await api.get('/tasks');
    setTasks(res.data);
    res.data.forEach((task: Task) => fetchComments(task._id));
  };
  const fetchUsers = async () => setAllUsers((await api.get('/users')).data);
  const fetchMessages = async () => setMessages((await api.get('/messages')).data);
  const fetchComments = async (taskId: string) => {
    const res = await api.get(`/tasks/${taskId}/comments`);
    setTaskComments((prev) => ({ ...prev, [taskId]: res.data }));
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (isLogin) {
        const res = await api.post('/auth/login', { email, password });
        const authenticatedUser: User = {
          ...res.data.user,
          theme: isThemeName(res.data.user?.theme) ? res.data.user.theme : 'classic',
        };
        localStorage.setItem('token', res.data.token);
        localStorage.setItem('user', JSON.stringify(authenticatedUser));
        setUser(authenticatedUser);
        setTheme(authenticatedUser.theme || 'classic');
      } else {
        await api.post('/auth/register', { username, email, password });
        setIsLogin(true);
        setError('Registration successful! Please login.');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setActiveView('dashboard');
    setTheme('classic');
    setSettingsError('');
    setUser(null);
  };

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.title.trim()) return;
    await api.post('/tasks', newTask);
    setNewTask({ title: '', description: '', dueDate: '' });
    await fetchTasks();
  };
  const toggleTask = async (id: string) => {
    await api.patch(`/tasks/${id}/complete`);
    await fetchTasks();
  };
  const deleteTask = async (id: string) => {
    await api.delete(`/tasks/${id}`);
    await fetchTasks();
  };
  const addComment = async (taskId: string) => {
    if (!newComment[taskId]?.trim()) return;
    const res = await api.post(`/tasks/${taskId}/comments`, { commentText: newComment[taskId] });
    setTaskComments((prev) => ({ ...prev, [taskId]: [...(prev[taskId] || []), res.data] }));
    setNewComment((prev) => ({ ...prev, [taskId]: '' }));
  };
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage || !user) return;
    setNewMessage('');

    if (socket) {
      socket.emit('send_message', { senderId: user.id, senderName: user.username, message: trimmedMessage });
      return;
    }

    try {
      const res = await api.post('/messages', { message: trimmedMessage });
      setMessages((prev) => [...prev, res.data]);
    } catch (error) {
      console.error(error);
      setNewMessage(trimmedMessage);
    }
  };
  const changeThemeForCurrentUser = async (nextTheme: ThemeName) => {
    setTheme(nextTheme);
    setSettingsError('');
    if (!user) return;

    const previousTheme = isThemeName(user.theme) ? user.theme : 'classic';
    try {
      const res = await api.patch('/users/me/theme', { theme: nextTheme });
      const updatedUser: User = {
        ...user,
        theme: isThemeName(res.data?.theme) ? res.data.theme : nextTheme,
      };
      setUser(updatedUser);
      localStorage.setItem('user', JSON.stringify(updatedUser));
    } catch (themeError) {
      console.error(themeError);
      setSettingsError('Failed to save theme. Please try again.');
      setTheme(previousTheme);
    }
  };
  const deleteCurrentAccount = async () => {
    if (!user || deletingAccount) return;
    const confirmDelete = window.confirm('Delete your account permanently? This will remove your tasks, comments, and messages.');
    if (!confirmDelete) return;

    setDeletingAccount(true);
    setSettingsError('');
    try {
      await api.delete('/users/me');
      handleLogout();
    } catch (deleteError: any) {
      console.error(deleteError);
      setSettingsError(deleteError.response?.data?.error || 'Failed to delete account. Please try again.');
    } finally {
      setDeletingAccount(false);
    }
  };

  const getTaskVisualState = (task: Task): TaskVisualState => {
    if (task.completed) return 'completed';
    if (!task.dueDate) return 'normal';

    const dueInput = task.dueDate.includes('T') ? task.dueDate : `${task.dueDate}T23:59:59`;
    const dueMs = new Date(dueInput).getTime();
    if (Number.isNaN(dueMs)) return 'normal';

    const diffMs = dueMs - nowMs;
    if (diffMs < 0) return 'overdue';
    if (diffMs <= ONE_DAY_MS) return 'nearDeadline';
    return 'normal';
  };

  if (!user) {
    return (
      <div className={cn('min-h-screen flex items-center justify-center p-4', t.appBg)}>
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md border border-black/5">
          <div className="text-center mb-8">
            <div className={cn('w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4', t.logo)}>
              <CheckSquare className="text-white w-8 h-8" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">LittleChats</h1>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            {!isLogin && <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-gray-200 outline-none" placeholder="Username" required />}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-gray-200 outline-none" placeholder="Email" required />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-gray-200 outline-none" placeholder="Password" required />
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button type="submit" disabled={loading} className={cn('w-full text-white py-3 rounded-xl font-semibold transition-colors', t.primary, t.primaryHover)}>
              {loading ? 'Processing...' : isLogin ? 'Sign In' : 'Create Account'}
            </button>
          </form>
          <button onClick={() => setIsLogin(!isLogin)} className="mt-4 w-full text-sm text-gray-600 hover:text-black">
            {isLogin ? "Don't have an account? Sign Up" : 'Already have an account? Sign In'}
          </button>
        </div>
      </div>
    );
  }

  const renderTaskCard = (task: Task) => {
    const isOwner = task.createdBy === user.id || task.createdBy === user._id;
    const visualState = getTaskVisualState(task);
    const isCompleted = visualState === 'completed';
    const isNearDeadline = visualState === 'nearDeadline';
    const isOverdue = visualState === 'overdue';

    return (
      <motion.div
        key={task._id}
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className={cn(
          'rounded-2xl border overflow-hidden shadow-sm',
          isCompleted
            ? 'bg-emerald-50 border-emerald-200'
            : isOverdue
              ? 'bg-red-50 border-red-200'
              : isNearDeadline
                ? 'bg-orange-50 border-orange-200'
                : 'bg-white border-black/5'
        )}
      >
        <div className="p-5 flex items-start gap-4">
          <button onClick={() => isOwner && toggleTask(task._id)} disabled={!isOwner} className={cn('mt-1', isCompleted ? 'text-emerald-600' : isOverdue ? 'text-red-500' : isNearDeadline ? 'text-orange-500' : isOwner ? 'text-gray-400 hover:text-black' : 'text-gray-200 cursor-not-allowed')}>
            {isCompleted ? <CheckCircle2 className="w-6 h-6 text-emerald-500" /> : <Circle className="w-6 h-6" />}
          </button>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <h3 className={cn('text-lg font-bold', isCompleted ? 'line-through text-emerald-700' : isOverdue ? 'text-red-700' : isNearDeadline ? 'text-orange-700' : 'text-gray-900')}>{task.title}</h3>
              {isOwner && <button onClick={() => deleteTask(task._id)} className="p-2 text-gray-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>}
            </div>
            {task.description && <p className={cn('text-sm mb-3', isCompleted ? 'text-emerald-700/80' : isOverdue ? 'text-red-700/80' : isNearDeadline ? 'text-orange-700/80' : 'text-gray-600')}>{task.description}</p>}
            <div className={cn('text-[11px] font-bold uppercase tracking-wider flex gap-4', isCompleted ? 'text-emerald-700/70' : isOverdue ? 'text-red-700/70' : isNearDeadline ? 'text-orange-700/70' : 'text-gray-400')}>
              <span className="flex items-center gap-1"><UserIcon className="w-3.5 h-3.5" />{task.createdByUsername}</span>
              {task.dueDate && <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{format(new Date(task.dueDate), 'MMM d, yyyy')}</span>}
            </div>
            {!isCompleted && isNearDeadline && (
              <span className="inline-flex mt-3 items-center rounded-full border border-orange-200 bg-orange-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-700">
                Due Soon
              </span>
            )}
            {!isCompleted && isOverdue && (
              <span className="inline-flex mt-3 items-center rounded-full border border-red-200 bg-red-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-red-700">
                Overdue
              </span>
            )}
          </div>
        </div>
        <div className={cn('border-t p-5', isCompleted ? 'bg-emerald-100/60 border-emerald-200' : isOverdue ? 'bg-red-100/60 border-red-200' : isNearDeadline ? 'bg-orange-100/60 border-orange-200' : 'bg-gray-50 border-black/5')}>
          <div className="flex items-center gap-2 mb-4 text-xs font-bold text-gray-400 uppercase tracking-widest"><MessageCircle className="w-4 h-4" />Discussion</div>
          <div className="space-y-4 mb-4">
            {taskComments[task._id]?.map((c) => (
              <div key={c._id} className="flex gap-3">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center border border-black/5 text-[10px] font-bold">{(c.username || '?').charAt(0).toUpperCase()}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5"><span className="text-xs font-bold">{c.username}</span><span className="text-[10px] text-gray-400">{format(new Date(c.createdAt), 'MMM d, HH:mm')}</span></div>
                  <p className="text-sm text-gray-600">{c.commentText}</p>
                </div>
              </div>
            ))}
            {(!taskComments[task._id] || taskComments[task._id].length === 0) && <p className="text-xs text-gray-400 italic">No comments yet. Start the conversation!</p>}
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="Add a comment..." value={newComment[task._id] || ''} onChange={(e) => setNewComment((prev) => ({ ...prev, [task._id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && addComment(task._id)} className="flex-1 px-4 py-2 bg-white rounded-xl border border-gray-200 text-sm outline-none" />
            <button onClick={() => addComment(task._id)} className={cn('p-2 text-white rounded-xl', t.primary, t.primaryHover)}><Send className="w-4 h-4" /></button>
          </div>
        </div>
      </motion.div>
    );
  };

  return (
    <div className={cn('h-screen flex flex-col', t.appBg)}>
      <header className={cn('px-6 py-4 border-b border-black/5 shadow-sm flex items-center justify-between', t.headerBg)}>
        <div className="flex items-center gap-3">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', t.logo)}><CheckSquare className="text-white w-5 h-5" /></div>
          <h1 className="text-xl font-bold tracking-tight">LittleChats</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setActiveView('dashboard')} className={cn('px-3 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 border', activeView === 'dashboard' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-black/10')}><LayoutDashboard className="w-4 h-4" />Dashboard</button>
          <button onClick={() => setActiveView('profile')} className={cn('px-3 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 border', activeView === 'profile' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-black/10')}><UserIcon className="w-4 h-4" />Profile</button>
          <button onClick={() => setActiveView('settings')} className={cn('px-3 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 border', activeView === 'settings' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-black/10')}><Settings className="w-4 h-4" />Settings</button>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-3 py-1.5 bg-gray-100 rounded-full text-sm font-semibold">{user.username}</div>
          <button onClick={handleLogout} className="p-2 hover:bg-red-50 text-gray-500 hover:text-red-600 rounded-xl"><LogOut className="w-5 h-5" /></button>
        </div>
      </header>

      <AnimatePresence mode="wait">
        <motion.main
          key={activeView}
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -10, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={activeView === 'dashboard' ? 'flex-1 flex overflow-hidden' : 'flex-1 overflow-y-auto p-8'}
        >
          {activeView === 'profile' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <section className="bg-white rounded-2xl border border-black/5 p-6">
                <h2 className="text-2xl font-bold mb-4">Profile</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-gray-50 rounded-xl p-4"><p className="text-gray-500 text-sm">Username</p><p className="font-semibold">{user.username}</p></div>
                  <div className="bg-gray-50 rounded-xl p-4"><p className="text-gray-500 text-sm">Email</p><p className="font-semibold">{user.email}</p></div>
                </div>
              </section>
              <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-2xl border border-black/5 p-5"><p className="text-xs text-gray-400 uppercase font-bold">Total Tasks</p><p className="text-3xl font-bold">{tasks.length}</p></div>
                <div className="bg-emerald-50 rounded-2xl border border-emerald-200 p-5"><p className="text-xs text-emerald-700 uppercase font-bold">Completed</p><p className="text-3xl font-bold text-emerald-800">{completed}</p></div>
                <div className="bg-amber-50 rounded-2xl border border-amber-200 p-5"><p className="text-xs text-amber-700 uppercase font-bold">Pending</p><p className="text-3xl font-bold text-amber-800">{tasks.length - completed}</p></div>
              </section>
            </div>
          )}

          {activeView === 'settings' && (
            <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-black/5 p-6">
              <h2 className="text-2xl font-bold mb-1">Settings</h2>
              <p className="text-sm text-gray-500 mb-6">Choose a theme for your dashboard.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(Object.keys(themes) as ThemeName[]).map((name) => (
                  <button key={name} onClick={() => changeThemeForCurrentUser(name)} className={cn('text-left rounded-2xl border p-4', theme === name ? 'border-black shadow-md' : 'border-black/10 hover:border-black/30')}>
                    <div className="flex items-center justify-between mb-2"><h3 className="font-bold">{themes[name].label}</h3>{theme === name && <span className="text-xs font-bold">Active</span>}</div>
                    <div className={cn('rounded-xl p-3 border border-black/10', themes[name].appBg)}>
                      <div className={cn('h-3 w-20 rounded mb-2', themes[name].logo)} />
                      <div className={cn('h-7 w-24 rounded', themes[name].primary)} />
                    </div>
                  </button>
                ))}
              </div>
              {settingsError && (
                <p className="mt-4 text-sm font-medium text-red-600">{settingsError}</p>
              )}
              <div className="mt-8 border-t border-red-200 pt-6">
                <h3 className="text-lg font-bold text-red-700">Danger Zone</h3>
                <p className="mt-1 text-sm text-gray-500">Delete your account and all related data permanently.</p>
                <button
                  onClick={deleteCurrentAccount}
                  disabled={deletingAccount}
                  className="mt-4 inline-flex items-center rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingAccount ? 'Deleting Account...' : 'Delete This Account'}
                </button>
              </div>
            </div>
          )}

          {activeView === 'dashboard' && (
            <>
              <section className="flex-1 overflow-y-auto p-8 border-r border-black/5">
                <div className="max-w-4xl mx-auto">
                  <div className="flex items-center justify-between mb-8">
                    <h2 className="text-2xl font-bold">Task Feed</h2>
                    <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-black/5">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                  </div>
                  <form onSubmit={createTask} className="bg-white p-6 rounded-2xl border border-black/5 mb-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <input type="text" placeholder="What needs to be done?" value={newTask.title} onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} className="md:col-span-2 w-full px-4 py-2 text-lg border-none outline-none" required />
                      <textarea placeholder="Add a description..." value={newTask.description} onChange={(e) => setNewTask({ ...newTask, description: e.target.value })} className="md:col-span-2 w-full px-4 py-2 border-none outline-none resize-none text-gray-600" rows={2} />
                      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl"><Calendar className="w-4 h-4 text-gray-400" /><input type="date" value={newTask.dueDate} onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })} className="bg-transparent border-none outline-none text-sm text-gray-600" /></div>
                      <div className="flex justify-end"><button type="submit" className={cn('text-white px-6 py-2 rounded-xl font-semibold flex items-center gap-2', t.primary, t.primaryHover)}><Plus className="w-4 h-4" />Create Task</button></div>
                    </div>
                  </form>
                  <div className="space-y-8">
                    <section>
                      <div className="mb-4 flex items-center justify-between">
                        <h3 className="text-lg font-bold text-gray-900">My Tasks</h3>
                        <span className="text-xs font-semibold text-gray-500 bg-white px-2.5 py-1 rounded-full border border-black/10">
                          {myTasks.length}
                        </span>
                      </div>
                      {myTasks.length === 0 ? (
                        <p className="text-sm text-gray-500 bg-white border border-black/5 rounded-xl px-4 py-3">
                          You do not have any tasks yet.
                        </p>
                      ) : (
                        <div className="space-y-6">
                          <AnimatePresence mode="popLayout">
                            {myTasks.map(renderTaskCard)}
                          </AnimatePresence>
                        </div>
                      )}
                    </section>

                    <section>
                      <div className="mb-4 flex items-center justify-between">
                        <h3 className="text-lg font-bold text-gray-900">Other Users Tasks</h3>
                        <span className="text-xs font-semibold text-gray-500 bg-white px-2.5 py-1 rounded-full border border-black/10">
                          {otherUserTasks.length}
                        </span>
                      </div>
                      {otherUserTasks.length === 0 ? (
                        <p className="text-sm text-gray-500 bg-white border border-black/5 rounded-xl px-4 py-3">
                          No tasks from other users.
                        </p>
                      ) : (
                        <div className="space-y-6">
                          <AnimatePresence mode="popLayout">
                            {otherUserTasks.map(renderTaskCard)}
                          </AnimatePresence>
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              </section>

              <aside className="w-80 bg-white border-l border-black/5 flex flex-col">
                <div className="p-4 border-b border-black/5">
                  <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Team Members</h3>
                  <div className="flex flex-wrap gap-2">
                    {allUsers.map((u) => (
                      <div key={u.id || u._id} className="relative" title={`${u.username} is ${u.onlineStatus ? 'Online' : 'Offline'}`}>
                        <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2', u.onlineStatus ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-gray-50 text-gray-400')}>{(u.username || '?').charAt(0).toUpperCase()}</div>
                        {u.onlineStatus && <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white" />}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-4 border-b border-black/5 flex items-center gap-2 bg-gray-50/50"><MessageSquare className="w-5 h-5 text-gray-400" /><h2 className="font-bold">Team Chat</h2></div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.map((m, i) => (
                    <div key={m._id || i} className={cn('flex flex-col', m.senderId === user.id ? 'items-end' : 'items-start')}>
                      <div className="flex items-center gap-2 mb-1 px-1"><span className="text-[10px] font-bold text-gray-500 uppercase">{m.senderName}</span><span className="text-[10px] text-gray-300 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{format(new Date(m.timestamp), 'HH:mm')}</span></div>
                      <div className={cn('px-4 py-2.5 rounded-2xl text-sm max-w-[90%]', m.senderId === user.id ? `${t.primary} text-white rounded-tr-none` : 'bg-gray-100 text-gray-800 rounded-tl-none border border-black/5')}>{m.message}</div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <form onSubmit={sendMessage} className="p-4 border-t border-black/5 bg-gray-50">
                  <div className="relative">
                    <input type="text" placeholder="Type a message..." value={newMessage} onChange={(e) => setNewMessage(e.target.value)} className="w-full pl-4 pr-12 py-3 bg-white rounded-xl border border-gray-200 outline-none text-sm" />
                    <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-black"><Send className="w-4 h-4" /></button>
                  </div>
                </form>
              </aside>
            </>
          )}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}


