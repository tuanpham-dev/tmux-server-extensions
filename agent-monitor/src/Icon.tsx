// Copied from tmux-server's client/src/components/Icon.tsx — the codicon
// font is loaded by the host, so an extension only needs the class names. A
// copy rather than an import, same as every other helper here.
interface Props {
  name: string;
  className?: string;
}

export default function Icon({ name, className }: Props) {
  return <span className={`codicon codicon-${name}${className ? ` ${className}` : ""}`} />;
}
