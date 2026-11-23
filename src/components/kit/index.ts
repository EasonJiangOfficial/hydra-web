// Hydra design kit (DESIGN.md section 7). Import from "@/components/kit".
export { cn } from "@/lib/utils";
export { Card, Strip, Stat, Label, Pill, ListRow, type As, type StatProps } from "./card";
export { Money, formatMoney, moneyParts, type MoneyFormat, type MoneyProps } from "./money";
export { MotionNumber, Bar, type MotionNumberProps, type BarProps } from "./motion";
export { Seg, EASE, STATE_TRANSITION, type SegItem, type SegProps } from "./seg";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
export { HoverCard, InfoDot, type HoverCardProps, type InfoDotProps } from "./hover-card";
export { DetailDrawer, drawerHref, setDrawerUrl, type DrawerParam, type DetailDrawerProps } from "./drawer";
export {
  Skeleton,
  SkeletonCard,
  SkeletonStat,
  SkeletonStrip,
  SkeletonRows,
  SkeletonChart,
  SkeletonHero,
  SkeletonPanel,
  FadeIn,
} from "./skeleton";
export { HydraLoader, type HydraLoaderProps } from "./hydra-loader";
export { DayCell, DayLegend, dayState, type DayCellProps, type DayState } from "./day-cell";
export {
  TrendLine,
  Bars,
  Donut,
  Sparkline,
  Sankey,
  type TrendLineProps,
  type TrendPoint,
  type BarsProps,
  type DonutProps,
  type SparklineProps,
  type SankeyProps,
  type SankeyNode,
} from "./charts";
export { Button, buttonVariants } from "@/components/ui/button";
export { Input } from "@/components/ui/input";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "@/components/ui/table";
