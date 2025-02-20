# ddt-ui-terminal

Terminal UI for ddt.vim

![2025-02-20_10-11](https://github.com/user-attachments/assets/2b2b22a0-f820-4587-984b-a8c028004b4a)

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddt.vim

https://github.com/Shougo/ddt.vim

## Configuration

```vim
call ddt#custom#patch_global(#{
    \   ui: 'terminal',
    \   uiParams: #{
    \     terminal: #{
    \       command: ['zsh'],
    \       promptPattern: has('win32') ? '\f\+>' : '\w*% \?',
    \     },
    \   },
    \ })
```
