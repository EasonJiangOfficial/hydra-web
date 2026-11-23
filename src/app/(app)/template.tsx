/** Remounts on every navigation, so each page's top blocks mount fresh and take the layout's fade (see layout.tsx). */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}
