# Agentbox Neovim - Pre-configured neovim for AI coding agents
# This mirrors the configuration from modules/common/editor.nix
# but packaged as a standalone derivation for use in Docker images
{
  lib,
  neovim-unwrapped,
  vimPlugins,
  writeText,
  wrapNeovimUnstable,
}:

let
  # Lua configuration - extracted from modules/common/editor.nix
  # Simplified for container use (removed k9s, lazydocker, helm integrations)
  initLua = writeText "init.lua" ''
    -- Agentbox Neovim Configuration
    -- Based on nix-config/modules/common/editor.nix

    -- Set leader key
    vim.g.mapleader = "\\"

    -- UI Settings
    vim.opt.number = true
    vim.opt.relativenumber = true
    vim.opt.termguicolors = true
    vim.opt.mouse = "a"
    vim.opt.tabstop = 2
    vim.opt.shiftwidth = 2
    vim.opt.expandtab = true
    vim.opt.clipboard = "unnamedplus"

    -- Auto-open terminal in horizontal split on startup
    vim.api.nvim_create_autocmd("VimEnter", {
      callback = function()
        if vim.fn.argc() == 0 then
          vim.cmd("below split | terminal")
          vim.cmd("wincmd k")
        end
      end
    })

    -- Theme
    vim.cmd[[colorscheme tokyonight]]

    -- Diagnostics Configuration
    vim.diagnostic.config({
      virtual_text = {
        prefix = '●',
        spacing = 4,
        source = "if_many",
      },
      signs = {
        text = {
          [vim.diagnostic.severity.ERROR] = " ",
          [vim.diagnostic.severity.WARN] = " ",
          [vim.diagnostic.severity.HINT] = "󰌵 ",
          [vim.diagnostic.severity.INFO] = " ",
        },
      },
      underline = true,
      update_in_insert = false,
      severity_sort = true,
      float = {
        border = "rounded",
        source = true,
        header = "",
        prefix = "",
      },
    })

    -- Bufferline (Tabs)
    require("bufferline").setup{
      options = {
        mode = "buffers",
        numbers = "ordinal",
        diagnostics = "nvim_lsp",
        separator_style = "slant",
        show_buffer_close_icons = false,
        show_close_icon = false,
      }
    }
    vim.keymap.set('n', '<Tab>', ':BufferLineCycleNext<CR>', { noremap = true, silent = true })
    vim.keymap.set('n', '<S-Tab>', ':BufferLineCyclePrev<CR>', { noremap = true, silent = true })
    vim.keymap.set('n', '<leader>bd', function()
      local bufs = vim.fn.getbufinfo({buflisted = 1})
      if #bufs > 1 then
        vim.cmd('bprevious | bdelete #')
      else
        vim.cmd('enew | bdelete #')
      end
    end, { noremap = true, silent = true, desc = "Close buffer" })

    -- Lualine
    require('lualine').setup {
      options = { theme = 'tokyonight' }
    }

    -- Neo-tree (File Explorer)
    require("neo-tree").setup({
      close_if_last_window = true,
      window = { width = 35 },
      filesystem = {
        follow_current_file = { enabled = true },
        use_libuv_file_watcher = true,
      },
    })
    vim.keymap.set('n', '<C-n>', ':Neotree toggle<CR>', { noremap = true, silent = true })
    vim.keymap.set('n', '<leader>e', ':Neotree focus<CR>', { noremap = true, silent = true })

    -- ToggleTerm
    require("toggleterm").setup{
      direction = 'float',
      size = 20,
      float_opts = {
        border = 'curved',
        width = 120,
        height = 30,
      },
      shade_terminals = true,
      start_in_insert = true,
    }
    vim.keymap.set('n', '<C-\\>', ':ToggleTerm direction=float<CR>', { noremap = true, silent = true })
    vim.keymap.set('n', '<leader>Tf', ':ToggleTerm direction=float<CR>', { desc = 'Toggle floating terminal' })
    vim.keymap.set('n', '<leader>Th', ':ToggleTerm direction=horizontal<CR>', { desc = 'Toggle horizontal terminal' })
    vim.keymap.set('n', '<leader>Tv', ':ToggleTerm direction=vertical<CR>', { desc = 'Toggle vertical terminal' })

    function _G.set_terminal_keymaps()
      local opts = {buffer = 0}
      vim.keymap.set('t', '<esc>', [[<C-\><C-n>]], opts)
      vim.keymap.set('t', 'jk', [[<C-\><C-n>]], opts)
      vim.keymap.set('t', '<C-h>', [[<Cmd>wincmd h<CR>]], opts)
      vim.keymap.set('t', '<C-j>', [[<Cmd>wincmd j<CR>]], opts)
      vim.keymap.set('t', '<C-k>', [[<Cmd>wincmd k<CR>]], opts)
      vim.keymap.set('t', '<C-l>', [[<Cmd>wincmd l<CR>]], opts)
    end
    vim.cmd('autocmd! TermOpen term://* lua set_terminal_keymaps()')

    -- Comment.nvim
    require('Comment').setup()

    -- Trouble (Diagnostics)
    require("trouble").setup()
    vim.keymap.set("n", "<leader>xx", function() require("trouble").toggle() end)
    vim.keymap.set("n", "<leader>xw", function() require("trouble").toggle("workspace_diagnostics") end)

    -- Telescope
    require("telescope").setup({
      defaults = {
        vimgrep_arguments = {
          "rg", "--color=never", "--no-heading", "--with-filename",
          "--line-number", "--column", "--smart-case",
        },
      },
    })
    local builtin = require('telescope.builtin')
    vim.keymap.set('n', '<C-p>', builtin.find_files, {})
    vim.keymap.set('n', '<leader>ff', builtin.find_files, {})
    vim.keymap.set('n', '<leader>fg', builtin.live_grep, {})
    vim.keymap.set('n', '<leader>fb', builtin.buffers, {})
    vim.keymap.set('n', '<leader>fh', builtin.help_tags, {})

    -- Treesitter
    -- nvim-treesitter was rewritten on its main branch (shipped in nixpkgs 26.05+):
    -- 'nvim-treesitter.configs' no longer exists and features are enabled per buffer.
    -- This package currently builds against an older nixpkgs (master branch plugin),
    -- so support both APIs. Grammars come pre-installed via withAllGrammars.
    local has_legacy_ts, legacy_ts_configs = pcall(require, 'nvim-treesitter.configs')
    if has_legacy_ts then
      legacy_ts_configs.setup {
        highlight = { enable = true },
        indent = { enable = true },
      }
    else
      vim.api.nvim_create_autocmd('FileType', {
        callback = function(args)
          if pcall(vim.treesitter.start, args.buf) then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
          end
        end,
      })
    end

    -- Gitsigns
    require('gitsigns').setup({
      signs = {
        add          = { text = '│' },
        change       = { text = '│' },
        delete       = { text = '_' },
        topdelete    = { text = '‾' },
        changedelete = { text = '~' },
        untracked    = { text = '┆' },
      },
      current_line_blame = true,
      current_line_blame_opts = {
        virt_text = true,
        virt_text_pos = 'eol',
        delay = 500,
      },
      current_line_blame_formatter = '<author>, <author_time:%Y-%m-%d> - <summary>',
      on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        vim.keymap.set('n', ']c', function()
          if vim.wo.diff then return ']c' end
          vim.schedule(function() gs.next_hunk() end)
          return '<Ignore>'
        end, {expr=true, buffer=bufnr})
        vim.keymap.set('n', '[c', function()
          if vim.wo.diff then return '[c' end
          vim.schedule(function() gs.prev_hunk() end)
          return '<Ignore>'
        end, {expr=true, buffer=bufnr})
        vim.keymap.set('n', '<leader>hs', gs.stage_hunk, {buffer=bufnr})
        vim.keymap.set('n', '<leader>hr', gs.reset_hunk, {buffer=bufnr})
        vim.keymap.set('n', '<leader>hp', gs.preview_hunk, {buffer=bufnr})
        vim.keymap.set('n', '<leader>hb', function() gs.blame_line{full=true} end, {buffer=bufnr})
      end
    })

    -- Diffview
    require("diffview").setup({
      enhanced_diff_hl = true,
      view = {
        default = { layout = "diff2_horizontal" },
        merge_tool = { layout = "diff3_mixed" },
      },
      file_panel = {
        listing_style = "tree",
        win_config = { width = 35 },
      },
    })
    vim.keymap.set('n', '<leader>gd', '<cmd>DiffviewOpen<cr>', { desc = 'Git diff view' })
    vim.keymap.set('n', '<leader>gh', '<cmd>DiffviewFileHistory %<cr>', { desc = 'File git history' })
    vim.keymap.set('n', '<leader>gc', '<cmd>DiffviewClose<cr>', { desc = 'Close diff view' })

    -- WhichKey
    local wk = require("which-key")
    wk.setup({
      plugins = { marks = true, registers = true, spelling = { enabled = true } },
      triggers = { { "<auto>", mode = "nxsot" } },
    })
    wk.add({
      { "<leader>T", group = "Terminal" },
      { "<leader>h", group = "Git Hunks" },
      { "<leader>g", group = "Git/Diffview" },
      { "<leader>t", group = "Test" },
      { "<leader>x", group = "Trouble/Todo" },
      { "<leader>f", group = "Find/Format" },
      { "<leader>b", group = "Buffer" },
      { "<leader>d", group = "Debug" },
      { "<leader>v", group = "LSP" },
    })

    -- Indent Blankline
    local highlight = {
      "IndentRainbowRed", "IndentRainbowYellow", "IndentRainbowBlue",
      "IndentRainbowOrange", "IndentRainbowGreen", "IndentRainbowViolet", "IndentRainbowCyan",
    }
    local hooks = require("ibl.hooks")
    hooks.register(hooks.type.HIGHLIGHT_SETUP, function()
      vim.api.nvim_set_hl(0, "IndentRainbowRed", { fg = "#4a3a3a" })
      vim.api.nvim_set_hl(0, "IndentRainbowYellow", { fg = "#4a4a3a" })
      vim.api.nvim_set_hl(0, "IndentRainbowBlue", { fg = "#3a3a4a" })
      vim.api.nvim_set_hl(0, "IndentRainbowOrange", { fg = "#4a433a" })
      vim.api.nvim_set_hl(0, "IndentRainbowGreen", { fg = "#3a4a3a" })
      vim.api.nvim_set_hl(0, "IndentRainbowViolet", { fg = "#433a4a" })
      vim.api.nvim_set_hl(0, "IndentRainbowCyan", { fg = "#3a4a4a" })
    end)
    require("ibl").setup({
      indent = { char = "│", highlight = highlight },
      scope = { enabled = true, show_start = true, show_end = false },
    })

    -- Todo Comments
    require("todo-comments").setup({
      signs = true,
      keywords = {
        FIX = { icon = " ", color = "error", alt = { "FIXME", "BUG" } },
        TODO = { icon = " ", color = "info" },
        HACK = { icon = " ", color = "warning" },
        WARN = { icon = " ", color = "warning", alt = { "WARNING" } },
        NOTE = { icon = " ", color = "hint", alt = { "INFO" } },
      },
    })
    vim.keymap.set("n", "]t", function() require("todo-comments").jump_next() end)
    vim.keymap.set("n", "[t", function() require("todo-comments").jump_prev() end)
    vim.keymap.set("n", "<leader>xt", ":Trouble todo<CR>")

    -- LSP Setup
    local lspconfig = require("lspconfig")

    -- Go
    lspconfig.gopls.setup({
      settings = {
        gopls = {
          analyses = { unusedparams = true },
          staticcheck = true,
        },
      },
    })

    -- TypeScript/JavaScript
    lspconfig.ts_ls.setup({})

    -- Nix
    lspconfig.nil_ls.setup({})

    -- YAML
    lspconfig.yamlls.setup({
      settings = {
        yaml = {
          schemas = {
            ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
            ["https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json"] = "docker-compose*.{yml,yaml}",
          },
          validate = true,
        },
      },
    })

    -- LSP Keybindings
    vim.api.nvim_create_autocmd('LspAttach', {
      callback = function(args)
        local opts = {buffer = args.buf}
        vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
        vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
        vim.keymap.set("n", "<leader>vd", vim.diagnostic.open_float, opts)
        vim.keymap.set("n", "[d", vim.diagnostic.goto_next, opts)
        vim.keymap.set("n", "]d", vim.diagnostic.goto_prev, opts)
        vim.keymap.set("n", "<leader>vca", vim.lsp.buf.code_action, opts)
        vim.keymap.set("n", "<leader>vrr", vim.lsp.buf.references, opts)
        vim.keymap.set("n", "<leader>vrn", vim.lsp.buf.rename, opts)
        vim.keymap.set({'n', 'x'}, "<leader>f", function()
          vim.lsp.buf.format { async = true }
        end, opts)
      end
    })

    -- Debugging
    require("dapui").setup()
    local dap, dapui = require("dap"), require("dapui")
    dap.listeners.after.event_initialized["dapui_config"] = function() dapui.open() end
    dap.listeners.before.event_terminated["dapui_config"] = function() dapui.close() end
    dap.listeners.before.event_exited["dapui_config"] = function() dapui.close() end
    vim.keymap.set('n', '<leader>db', ':DapToggleBreakpoint<CR>')
    vim.keymap.set('n', '<leader>dc', ':DapContinue<CR>')

    -- Testing
    require("neotest").setup({
      adapters = {
        require("neotest-go"),
      },
    })
    vim.keymap.set('n', '<leader>tt', function() require("neotest").run.run() end)
    vim.keymap.set('n', '<leader>tf', function() require("neotest").run.run(vim.fn.expand("%")) end)

    -- Formatting
    require("conform").setup({
      formatters_by_ft = {
        lua = { "stylua" },
        go = { "gofmt", "goimports" },
        javascript = { "prettier" },
        typescript = { "prettier" },
        nix = { "nixfmt" },
      },
      format_on_save = {
        timeout_ms = 500,
        lsp_fallback = true,
      },
    })

    -- Blink.cmp (Autocompletion)
    require('blink.cmp').setup({
      keymap = {
        preset = 'default',
        ['<C-space>'] = { 'show', 'show_documentation', 'hide_documentation' },
        ['<C-e>'] = { 'hide', 'fallback' },
        ['<CR>'] = { 'accept', 'fallback' },
        ['<Tab>'] = { 'snippet_forward', 'fallback' },
        ['<S-Tab>'] = { 'snippet_backward', 'fallback' },
        ['<Up>'] = { 'select_prev', 'fallback' },
        ['<Down>'] = { 'select_next', 'fallback' },
        ['<C-p>'] = { 'select_prev', 'fallback' },
        ['<C-n>'] = { 'select_next', 'fallback' },
      },
      appearance = {
        use_nvim_cmp_as_default = true,
        nerd_font_variant = 'mono'
      },
      sources = {
        default = { 'lsp', 'path', 'snippets', 'buffer' },
      },
      completion = {
        menu = { border = 'rounded' },
        documentation = {
          auto_show = true,
          auto_show_delay_ms = 200,
          window = { border = 'rounded' },
        },
      },
      signature = {
        enabled = true,
        window = { border = 'rounded' },
      },
    })
  '';

  # Plugins matching modules/common/editor.nix
  plugins = with vimPlugins; [
    # Syntax & Highlighting
    nvim-treesitter.withAllGrammars
    vim-nix

    # UI & Theme
    tokyonight-nvim
    lualine-nvim
    bufferline-nvim
    neo-tree-nvim
    nui-nvim
    nvim-web-devicons
    which-key-nvim

    # Editor features
    comment-nvim
    toggleterm-nvim
    trouble-nvim
    indent-blankline-nvim
    todo-comments-nvim

    # Navigation
    telescope-nvim
    plenary-nvim
    vim-tmux-navigator

    # LSP & Completion
    nvim-lspconfig
    blink-cmp
    luasnip

    # Git
    diffview-nvim
    gitsigns-nvim

    # Debugging
    nvim-dap
    nvim-dap-ui
    nvim-nio

    # Testing
    neotest
    neotest-go

    # Formatting
    conform-nvim
  ];

in
wrapNeovimUnstable neovim-unwrapped {
  inherit plugins;
  neovimRcContent = ''
    luafile ${initLua}
  '';
  viAlias = true;
  vimAlias = true;
  wrapperArgs = [
    "--set"
    "EDITOR"
    "nvim"
    "--set"
    "VISUAL"
    "nvim"
  ];
}
