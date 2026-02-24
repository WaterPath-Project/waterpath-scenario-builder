import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { io } from 'socket.io-client';
import 'xterm/css/xterm.css';
import { X, Maximize2, Minimize2 } from 'lucide-react';

const Terminal = ({ onClose }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [currentCommand, setCurrentCommand] = useState('');

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm.js
    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selection: '#3d3d3d',
        black: '#1a1a1a',
        red: '#f44747',
        green: '#4caf50',
        yellow: '#ffeb3b',
        blue: '#2196f3',
        magenta: '#e91e63',
        cyan: '#00bcd4',
        white: '#ffffff',
        brightBlack: '#666666',
        brightRed: '#ff6b6b',
        brightGreen: '#69f0ae',
        brightYellow: '#fff176',
        brightBlue: '#64b5f6',
        brightMagenta: '#f48fb1',
        brightCyan: '#4dd0e1',
        brightWhite: '#ffffff'
      }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    
    terminal.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Connect to backend SocketIO
    const connectSocket = () => {
      try {
        const socket = io('http://localhost:5000');
        socketRef.current = socket;

        socket.on('connect', () => {
          setIsConnected(true);
          terminal.writeln('\x1b[32mConnected to GloWPa Container Terminal\x1b[0m');
          // Start shell session
          socket.emit('start_shell');
        });

        socket.on('disconnect', () => {
          setIsConnected(false);
          terminal.writeln('\r\n\x1b[31mConnection closed\x1b[0m');
        });

        socket.on('terminal_output', (data) => {
          if (data.data) {
            terminal.write(data.data);
          }
        });

        socket.on('connect_error', (error) => {
          setIsConnected(false);
          terminal.writeln('\r\n\x1b[31mConnection error. Make sure the backend supports terminal access.\x1b[0m');
          console.error('Socket connection error:', error);
        });

        // Handle terminal input
        terminal.onData((data) => {
          if (socket.connected) {
            // Handle special keys
            if (data === '\r') {
              // Enter key - send command
              socket.emit('terminal_input', { command: currentCommand });
              terminal.write('\r\n');
              setCurrentCommand('');
            } else if (data === '\u007F') {
              // Backspace
              if (currentCommand.length > 0) {
                setCurrentCommand(prev => prev.slice(0, -1));
                terminal.write('\b \b');
              }
            } else if (data === '\u0003') {
              // Ctrl+C
              socket.emit('terminal_input', { command: '^C' });
              setCurrentCommand('');
            } else {
              // Regular character
              setCurrentCommand(prev => prev + data);
              terminal.write(data);
            }
          }
        });

      } catch (error) {
        terminal.writeln('\x1b[31mFailed to connect to terminal service\x1b[0m');
        console.error('Terminal connection error:', error);
      }
    };

    connectSocket();

    // Handle window resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
    };
  }, [currentCommand]);

  const toggleMaximize = () => {
    setIsMaximized(!isMaximized);
    // Give a small delay for the CSS transition to complete before fitting
    setTimeout(() => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    }, 100);
  };

  return (
    <div className={`fixed bg-white rounded-lg shadow-2xl z-50 ${
      isMaximized 
        ? 'inset-4' 
        : 'top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-4/5 h-3/5 max-w-4xl'
    } transition-all duration-300`}>
      {/* Terminal Header */}
      <div className="bg-gray-800 text-white px-4 py-2 rounded-t-lg flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="font-medium">GloWPa Terminal</span>
          <span className="text-sm text-gray-300">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMaximize}
            className="text-gray-300 hover:text-white transition-colors"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            onClick={onClose}
            className="text-gray-300 hover:text-white transition-colors"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      
      {/* Terminal Content */}
      <div className="h-full pb-12">
        <div 
          ref={terminalRef} 
          className="h-full w-full p-2" 
          style={{ height: 'calc(100% - 40px)' }}
        />
      </div>
    </div>
  );
};

export default Terminal;
