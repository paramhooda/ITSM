import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The handover note body: Markdown under the fixed headings, rendered the same on the Handover page and the board panel. */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="prose-sm text-[13.5px] leading-relaxed [&_h2]:text-[12px] [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-subtle [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:my-0.5 [&_p]:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
