function ddt#ui#terminal#_split(params) abort
  if a:params.split ==# ''
    return
  endif

  if a:params.split ==# 'floating' && '*nvim_open_win'->exists()
    call nvim_open_win(bufnr('%'), v:true, #{
          \   relative: 'editor',
          \   row: a:params.winRow->str2nr(),
          \   col: a:params.winCol->str2nr(),
          \   width: a:params.winWidth->str2nr(),
          \   height: a:params.winHeight->str2nr(),
          \   border: a:params.floatingBorder,
          \ })
  elseif a:params.split ==# 'vertical'
    vsplit
    execute 'vertical resize' a:params.winWidth->str2nr()
  elseif a:params.split ==# 'farleft'
    vsplit
    wincmd H
    execute 'vertical resize' a:params.winWidth->str2nr()
  elseif a:params.split ==# 'farright'
    vsplit
    wincmd L
    execute 'vertical resize' a:params.winWidth->str2nr()
  else
    split
    execute 'resize' a:params.winHeight->str2nr()
  endif
endfunction

function ddt#ui#terminal#_get_cwd(pid, cmdline) abort
  const cwd = printf('/proc/%d/cwd', a:pid)
  if cwd->isdirectory()
    " Use proc filesystem.
    const directory = cwd->resolve()
  elseif 'lsof'->executable()
    " Use lsof instead.
    const directory = ('lsof -a -d cwd -p ' .. a:pid)
          \ ->system()->matchstr('\f\+\ze\n$')
  else
    " Parse from prompt.
    const directory = a:cmdline
          \ ->matchstr('\W\%(cd\s\+\)\?\zs\%(\S\|\\\s\)\+$')
          \ ->expand()
  endif

  return directory
endfunction
