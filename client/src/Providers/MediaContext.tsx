import { createContext, useContext } from 'react';
import type { TAttachment } from 'librechat-data-provider';

type MediaContext = {
  /** Message-scoped lookup pool for a selected child activity, with original ownership intact. */
  toolAttachments?: TAttachment[];
  /**
   * The turn's attachments, addressable by the filename a markdown image
   * names them with. A model that writes `![DTI](5_dti.png)` is referring to
   * a file the run produced, not to a path the browser can fetch, so the
   * markdown renderer resolves the reference through this map.
   */
  attachmentsByName?: ReadonlyMap<string, TAttachment>;
};

export const MediaContext = createContext<MediaContext>({});
export const useMediaContext = () => useContext(MediaContext);
