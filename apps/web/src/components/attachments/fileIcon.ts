import { Image as ImageIcon, FileText, FileArchive, FileSpreadsheet, File as FileIcon, FileCode, Film, Music, type LucideIcon } from 'lucide-react';

/** Icon for a file by content type, falling back to the extension. */
export function fileIcon(contentType: string, filename: string): LucideIcon {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (contentType.startsWith('image/')) return ImageIcon;
  if (contentType.startsWith('video/')) return Film;
  if (contentType.startsWith('audio/')) return Music;
  if (contentType === 'application/pdf' || contentType.startsWith('text/') || ['doc', 'docx', 'md'].includes(ext)) return FileText;
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext) || contentType.includes('zip') || contentType.includes('compressed')) return FileArchive;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['json', 'xml', 'yaml', 'yml', 'log'].includes(ext)) return FileCode;
  return FileIcon;
}
