import { Box, Keyboard, KeyRound, Settings, SlidersHorizontal } from 'lucide-react';
import type { ViewId } from '../../../types';

export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'Setup', icon: Settings, group: 'Project' },
  { id: 'workspace', label: 'Workspace', icon: Box, group: 'Project' },
  { id: 'api-keys', label: 'API keys', icon: KeyRound, group: 'Access' },
  { id: 'api-reference', label: 'API reference', icon: Keyboard, group: 'Developer' },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, group: 'Developer' },
] as const;

type VisibleSettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export type SettingsSection = VisibleSettingsSection
  | 'models'
  | 'loop-engine'
  | 'storage'
  | 'memory'
  | 'sandbox'
  | 'logs'
  | 'monitoring';
export const SETTINGS_GROUPS = ['Project', 'Access', 'Developer'] as const;
export const SETTINGS_VIEW_IDS: ViewId[] = [
  'settings', 'workspace', 'models', 'loop-engine', 'storage',
  'memory', 'sandbox', 'api-keys', 'api-reference', 'logs', 'monitoring', 'advanced',
];
