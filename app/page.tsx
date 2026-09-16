'use client';
import Planner from '@/components/planner';
import { createCesiumViewer } from '@/lib/visualization/cesium/factory';
export default function Home() {
  return <Planner viewerFactory={createCesiumViewer} />;
}
