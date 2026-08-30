/**
 * Every icon in the app, in one place.
 *
 * The app draws Tabler icons; this module is what makes that a one-line
 * change rather than a thousand. Call sites keep the names they always used,
 * so swapping the set again — or swapping one glyph — happens here and
 * nowhere else.
 *
 * Props carry over untouched. Tabler spreads its rest props onto the <svg>
 * last, so `strokeWidth={2.4}` and `fill="currentColor"` still override its
 * defaults exactly as they did before, which is why no call site changed.
 *
 * Names are verified against the package's own exports, not remembered.
 */

export {
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconAlignLeft as AlignLeft,
  IconArrowLeft as ArrowLeft,
  IconAt as AtSign,                // Tabler calls it what it is rather than what it looks like
  IconBell as Bell,
  IconCamera as Camera,
  IconCheck as Check,
  IconChecks as CheckCheck,            // two ticks — the read receipt
  IconCircleCheck as CheckCircle2,       // Tabler puts the shape first: Circle+Check
  IconChevronDown as ChevronDown,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconClock as Clock,
  IconCornerDownRight as CornerDownRight,
  IconDownload as Download,
  IconPencil as Edit3,            // the bare pencil; PenSquare below is the boxed one
  IconEye as Eye,
  IconEyeOff as EyeOff,
  IconFileText as FileText,
  IconMovie as Film,             // no Film in Tabler; Movie is the same clapper-free strip
  IconWorld as Globe,             // Tabler has no Globe — World is the same wire globe
  IconLayoutGrid as Grid,        // LayoutGrid, since Tabler reserves Grid for the dot grid
  IconHeart as Heart,
  IconHistory as History,
  IconHome as Home,
  IconPhoto as Image,             // Tabler names it after the content, not the file type
  IconPhotoOff as ImageOff,
  IconInfoCircle as Info,        // Tabler has no bare Info glyph, only the circled one
  IconKey as KeyRound,               // Tabler has one key and it is this shape
  IconStack2 as Layers,            // Stack2 is the three-sheet stack Layers draws
  IconList as List,
  IconListTree as ListTree,
  IconLoader2 as Loader2,
  IconLock as Lock,
  IconLogout as LogOut,
  IconMail as Mail,
  IconMapPin as MapPin,
  IconMaximize as Maximize,
  IconMessageCircle as MessageCircle,
  IconMessage as MessageSquare,           // plain Message is Tabler's square bubble
  IconMicrophone as Mic,        // spelled out
  IconDotsVertical as MoreVertical,      // Tabler names the glyph — three dots
  IconMusic as Music,
  IconPlayerPause as Pause,       // transport controls are prefixed Player in Tabler
  IconEdit as PenSquare,              // Edit is the pencil-in-a-box; the compose action
  IconPlayerPlay as Play,        // as above
  IconPlus as Plus,
  IconQrcode as QrCode,
  IconRefresh as RefreshCw,           // direction is not in the name
  IconArrowBackUp as Reply,       // ArrowBackUp is the reply arrow; Tabler has no Reply
  IconRotateClockwise as RotateCw,   // RotateClockwise spells the direction out
  IconSearch as Search,
  IconSend as Send,
  IconSettings as Settings,
  IconShare as Share,
  IconShare2 as Share2,
  IconShieldExclamation as ShieldAlert, // Exclamation rather than Alert
  IconShieldCheck as ShieldCheck,
  IconMoodSmile as Smile,         // the mood set
  IconSparkles as Sparkles,
  IconSquare as Square,
  IconTrash as Trash2,             // Tabler has one bin
  IconUser as User,
  IconUserPlus as UserPlus,
  IconUsers as Users,
  IconVideo as Video,
  IconVolume as Volume2,            // unnumbered; Tabler counts down for quieter, not up
  IconVolumeOff as VolumeX,         // Off rather than X
  IconX as X,
  IconBolt as Zap,              // Bolt — the lightning glyph
  IconZoomIn as ZoomIn,
  IconZoomOut as ZoomOut,
} from '@tabler/icons-react';
