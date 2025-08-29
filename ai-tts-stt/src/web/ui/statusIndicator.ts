/**
 * Status indicator UI component
 */

import { AppState } from '../types';
import { UIElements } from './dom';

export class StatusIndicator {
  constructor(private elements: UIElements) {}

  update(state: AppState) {
    const { statusIndicator } = this.elements;
    
    // Remove all status classes
    statusIndicator.className = '';
    
    // Set status based on state
    switch (state.connectionState) {
      case 'initial':
        statusIndicator.className = 'disconnected';
        statusIndicator.textContent = state.userRole === 'player' ? 'Ready to connect' : 'Not Published';
        break;
      case 'publishing':
        statusIndicator.className = 'connecting';
        statusIndicator.textContent = 'Publishing...';
        break;
      case 'published':
        statusIndicator.className = 'disconnected';
        statusIndicator.textContent = 'Published';
        break;
      case 'unpublishing':
        statusIndicator.className = 'connecting';
        statusIndicator.textContent = 'Unpublishing...';
        break;
      case 'connecting':
        statusIndicator.className = 'connecting';
        statusIndicator.textContent = 'Connecting...';
        break;
      case 'connected':
        statusIndicator.className = 'live';
        statusIndicator.textContent = 'Live';
        break;
      case 'disconnected':
        if (state.isPublished) {
          statusIndicator.className = 'disconnected';
          statusIndicator.textContent = 'Published';
        } else {
          statusIndicator.className = 'disconnected';
          statusIndicator.textContent = state.userRole === 'player' ? 'Ready to connect' : 'Not Published';
        }
        break;
    }
    
    // Add the base id back
    statusIndicator.id = 'statusIndicator';
  }
}
