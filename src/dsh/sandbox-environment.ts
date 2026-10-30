import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const findExecutable = async (name: string, path = process.env.PATH ?? ''): Promise<string | undefined> => {
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, name);

    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      /* Try the next absolute PATH entry. */
    }
  }

  return undefined;
};

export const inspectBubblewrapInstaller = async (find = findExecutable, root = process.getuid?.() === 0) => {
  for (const name of ['apt-get', 'dnf']) {
    const executable = await find(name);

    if (!executable) {
      continue;
    }
    const sudo = root ? undefined : await find('sudo');

    return { name, executable, sudo, root, manual: `sudo ${name} install -y bubblewrap` };
  }

  return undefined;
};
