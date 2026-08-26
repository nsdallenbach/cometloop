// Electron <webview> as a JSX intrinsic (the embedded console in the Tickets
// tab). Must live in a module file — a top-level import makes this an
// augmentation of React's types instead of a replacement.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}
