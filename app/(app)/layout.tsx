import { LogoutButton } from "@/components/shared/logout-button";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <p className="text-sm font-medium">Reddit Lead Finder</p>
        <LogoutButton />
      </header>
      {children}
    </div>
  );
}
