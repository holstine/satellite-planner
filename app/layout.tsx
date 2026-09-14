import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Orbit Desk — Satellite Planner',
  description: 'Local satellite observation planning and Cesium playback.',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="dark">{children}</body>
    </html>
  );
}
