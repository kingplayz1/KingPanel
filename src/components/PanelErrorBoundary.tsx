import React from 'react';
import { NavSection, ServerInstance } from '../types';
import { NotFound404View } from '../views/NotFound404View';

interface PanelErrorBoundaryProps {
  server: ServerInstance;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  children: React.ReactNode;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
  errorPath: string;
}

export class PanelErrorBoundary extends React.Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorPath: '/region/r.-404.-404.mca',
    };
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return {
      hasError: true,
      errorPath: error?.message || '/panel/runtime-exception-404',
    };
  }

  handleRecover = (section: NavSection) => {
    this.setState({ hasError: false });
    this.props.onNavigate(section);
  };

  render() {
    if (this.state.hasError) {
      return (
        <NotFound404View
          server={this.props.server}
          requestedPath={this.state.errorPath}
          onNavigate={this.handleRecover}
          onShowToast={this.props.onShowToast}
        />
      );
    }

    return this.props.children;
  }
}
