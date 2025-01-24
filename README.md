# ddt-ui-terminal

Terminal UI for ddt.vim

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
