// navbar.js
function initializeNavbar() {
    console.log('Initializing navbar'); // Debug: Confirm function runs
  
    const navLinks = document.querySelectorAll('.nav-link');
    console.log('Found', navLinks.length, 'nav links'); // Debug: Confirm links found
  
    navLinks.forEach(link => {
      link.addEventListener('click', function(event) {
        const href = this.getAttribute('href');
        const isModalTrigger = this.getAttribute('data-toggle') === 'modal';
        const isChargebeePortal = this.getAttribute('data-cb-type') === 'portal';
        console.log('Clicked link:', href, 'Modal trigger:', isModalTrigger, 'Chargebee portal:', isChargebeePortal); // Debug: Log clicks
  
        if (isChargebeePortal) {
          event.preventDefault();
          const existingCustomersModal = $('#existingCustomersModal');
          existingCustomersModal.modal('hide');
  
          // Redirect to Chargebee portal after modal closes
          existingCustomersModal.on('hidden.bs.modal', function() {
            console.log('Modal hidden, redirecting to Chargebee portal'); // Debug: Confirm redirect
            window.location.href = 'https://more4lessplans.chargebeeportal.com/portal/login';
          });
        } else if (!isModalTrigger && href && href !== '#') {
          event.preventDefault();
          const mobileMenuModal = document.getElementById('mobileMenuModal');
          if (mobileMenuModal) {
            console.log('Closing mobile menu modal'); // Debug: Confirm modal close
            $('#mobileMenuModal').modal('hide');
          }
          setTimeout(() => {
            console.log('Navigating to:', href); // Debug: Confirm navigation
            window.location.href = href;
          }, 300);
        }
      });
    });
  }