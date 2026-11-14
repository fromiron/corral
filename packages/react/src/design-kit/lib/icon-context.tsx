'use client';

// Components look icons up by role (`useIcons()["chevron-down"]`) so the set
// is swappable in one place. IconProvider is optional — without it, Lucide.
//
// Render from the `useIcons()` map, not `useIcon(name)`: the
// `react-hooks/static-components` lint flags rendering a component returned
// by a hook call.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Bot,
  Brain,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  Clock,
  Code,
  Copy,
  CornerDownLeft,
  CornerDownRight,
  Database,
  Dot,
  Download,
  Ellipsis,
  EllipsisVertical,
  Eye,
  FileText,
  Folder,
  GitBranch,
  Globe,
  GripVertical,
  Hand,
  Headset,
  Heart,
  Home,
  Hourglass,
  ImageIcon,
  Inbox,
  Info,
  Layers,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListFilter,
  Loader,
  Lock,
  Mail,
  Maximize2,
  Menu,
  MessageCircle,
  Minus,
  Monitor,
  Moon,
  Paintbrush,
  Palette,
  PanelLeft,
  PanelRight,
  Pause,
  Pencil,
  Pin,
  Pipette,
  Play,
  Plus,
  RectangleHorizontal,
  Rocket,
  RotateCcw,
  Scaling,
  Search,
  Send,
  Settings,
  Shield,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareLibrary,
  SquareTerminal,
  Star,
  Sun,
  Trash2,
  TriangleAlert,
  User,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, useContext, useMemo } from 'react';

// The contract an icon must meet. Forward `strokeWidth` and `className` to the
// `<svg>` — components animate stroke width through both.
export interface IconComponentProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export type IconComponent = ComponentType<IconComponentProps>;

// Names describe the role, not the glyph (`more-horizontal` is Lucide's Ellipsis).
export type IconName =
  | 'chevron-right'
  | 'chevron-down'
  | 'x'
  | 'copy'
  | 'menu'
  | 'dot'
  | 'monitor'
  | 'sun'
  | 'moon'
  | 'rectangle-horizontal'
  | 'circle'
  | 'square-library'
  | 'clock'
  | 'star'
  | 'settings'
  | 'plus'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'search'
  | 'loader'
  | 'users'
  | 'lock'
  | 'mail'
  | 'bell'
  | 'shield'
  | 'palette'
  | 'lightbulb'
  | 'rocket'
  | 'heart'
  | 'paintbrush'
  | 'brain'
  | 'globe'
  | 'user'
  | 'image'
  | 'link'
  | 'check'
  | 'rotate-ccw'
  | 'play'
  | 'pause'
  | 'pipette'
  | 'home'
  | 'message-circle'
  | 'inbox'
  | 'pencil'
  | 'scaling'
  | 'skip-forward'
  | 'corner-down-right'
  | 'corner-down-left'
  | 'panel-left'
  | 'panel-right'
  | 'chevrons-up-down'
  | 'more-horizontal'
  | 'more-vertical'
  | 'calendar'
  | 'folder'
  | 'sliders-horizontal'
  | 'info'
  // Agent UI
  | 'file'
  | 'terminal'
  | 'list-checks'
  | 'hand'
  | 'stop'
  | 'git-branch'
  | 'eye'
  | 'send'
  | 'trash'
  | 'grip-vertical'
  | 'list'
  | 'alert-triangle'
  | 'download'
  | 'bot'
  | 'shuffle'
  | 'filter'
  | 'zap'
  | 'layers'
  | 'hourglass'
  | 'headset'
  | 'maximize'
  | 'code'
  | 'database'
  | 'minus'
  | 'sparkles'
  | 'wrench'
  | 'pin';

export const defaultIcons: Record<IconName, IconComponent> = {
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  pipette: Pipette,
  x: X,
  copy: Copy,
  menu: Menu,
  dot: Dot,
  monitor: Monitor,
  sun: Sun,
  moon: Moon,
  'rectangle-horizontal': RectangleHorizontal,
  circle: Circle,
  'square-library': SquareLibrary,
  clock: Clock,
  star: Star,
  settings: Settings,
  plus: Plus,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  search: Search,
  loader: Loader,
  users: Users,
  lock: Lock,
  mail: Mail,
  bell: Bell,
  shield: Shield,
  palette: Palette,
  lightbulb: Lightbulb,
  rocket: Rocket,
  heart: Heart,
  paintbrush: Paintbrush,
  brain: Brain,
  globe: Globe,
  user: User,
  image: ImageIcon,
  link: Link,
  check: Check,
  'rotate-ccw': RotateCcw,
  play: Play,
  pause: Pause,
  home: Home,
  'message-circle': MessageCircle,
  inbox: Inbox,
  pencil: Pencil,
  scaling: Scaling,
  'skip-forward': SkipForward,
  'corner-down-right': CornerDownRight,
  'corner-down-left': CornerDownLeft,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  'chevrons-up-down': ChevronsUpDown,
  'more-horizontal': Ellipsis,
  'more-vertical': EllipsisVertical,
  calendar: Calendar,
  folder: Folder,
  'sliders-horizontal': SlidersHorizontal,
  info: Info,
  file: FileText,
  terminal: SquareTerminal,
  'list-checks': ListChecks,
  hand: Hand,
  stop: Square,
  'git-branch': GitBranch,
  eye: Eye,
  send: Send,
  trash: Trash2,
  'grip-vertical': GripVertical,
  list: List,
  'alert-triangle': TriangleAlert,
  download: Download,
  bot: Bot,
  shuffle: Shuffle,
  filter: ListFilter,
  zap: Zap,
  layers: Layers,
  hourglass: Hourglass,
  headset: Headset,
  maximize: Maximize2,
  code: Code,
  database: Database,
  minus: Minus,
  sparkles: Sparkles,
  wrench: Wrench,
  pin: Pin,
};

const IconContext = createContext<Record<IconName, IconComponent> | null>(null);

/**
 * Returns one icon component (Lucide without a provider). Fine for passing
 * on as a prop; to render it as `<Icon />`, read it from `useIcons()`.
 */
function useIcon(name: IconName): IconComponent {
  const icons = useContext(IconContext);
  return (icons ?? defaultIcons)[name];
}

/** Returns the full icon map (Lucide without a provider). */
function useIcons(): Record<IconName, IconComponent> {
  const icons = useContext(IconContext);
  return icons ?? defaultIcons;
}

/**
 * Swaps some or all icons; omitted names keep Lucide. Pass a stable `icons`
 * object (module scope or memoized) — an inline one re-renders every icon.
 */
function IconProvider({
  children,
  icons,
}: {
  children: ReactNode;
  icons?: Partial<Record<IconName, IconComponent>>;
}) {
  const value = useMemo(() => ({ ...defaultIcons, ...icons }), [icons]);
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export { IconProvider, useIcon, useIcons };
